/**
 * Streaming endpoint for the strategy-authoring assistant on /algo/[id].
 *
 * Differs from /api/chat: no thread persistence (these conversations are
 * scratch), one tool only (`propose_config` for proposing backtest-config
 * tweaks — code edits flow as fenced python blocks), tightly-scoped system
 * prompt that documents the sandbox DSL so the model doesn't suggest
 * disallowed imports.
 */
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from 'ai'
import { z } from 'zod'
import { buildModel } from '../../llm/model'

const STRATEGY_PROMPT = [
  'You are a trading-strategy authoring assistant for the user\'s sandboxed Python environment.',
  '',
  'When the user asks for a strategy or asks you to modify their existing one, your default response shape is:',
  '1) one short sentence describing what the strategy does',
  '2) a single ```python``` fenced code block containing the full strategy',
  '3) (optional) one or two bullets on parameters to tweak.',
  'Do not output more than one python code block. Do not narrate the obvious. Do not write multi-paragraph essays.',
  '',
  'STRATEGY SHAPE — REQUIRED, NO EXCEPTIONS:',
  'Every strategy you write MUST be wrapped in a top-level `def on_bar(c):` function.',
  'The runtime calls `on_bar(c)` once per bar. Code OUTSIDE that function runs once at',
  'load time and CANNOT reference `c` — top-level `df = c.bars` will fail with',
  '`NameError: name \'c\' is not defined` and the validator will reject your output.',
  '',
  'WRONG (validator will reject):',
  '```python',
  'df = c.bars                  # ← top-level, c is not bound',
  'if len(df) < 20:',
  '    c.hold()',
  '```',
  '',
  'RIGHT (canonical SMA crossover with proper warmup guard):',
  '```python',
  'import pandas as pd  # imports go ABOVE on_bar, not inside it',
  '',
  'def on_bar(c):',
  '    df = c.bars',
  '    # WARMUP GUARD: bail out EARLY if we don\'t have enough history.',
  '    # This avoids out-of-bounds errors in iloc[-N] and NaN comparisons',
  '    # on rolling windows that haven\'t filled yet. Always do this',
  '    # FIRST and `return` — never wrap your whole strategy inside the',
  '    # `len < N` block; that inverts the meaning.',
  '    if len(df) < 50:',
  '        c.hold()',
  '        return',
  '',
  '    closes = df[\'close\']',
  '    short_ma = closes.rolling(20).mean()',
  '    long_ma = closes.rolling(50).mean()',
  '    cur_short, prev_short = short_ma.iloc[-1], short_ma.iloc[-2]',
  '    cur_long,  prev_long  = long_ma.iloc[-1],  long_ma.iloc[-2]',
  '',
  '    crossed_up = prev_short <= prev_long and cur_short > cur_long',
  '    crossed_down = prev_short >= prev_long and cur_short < cur_long',
  '',
  '    if c.position == 0 and crossed_up:',
  '        c.buy()              # default qty from sizing mode',
  '    elif c.position > 0 and crossed_down:',
  '        c.sell()             # exits the whole position',
  '    else:',
  '        c.hold()',
  '```',
  '',
  'Module-level imports (math, numpy as np, pandas as pd) are fine ABOVE on_bar; they',
  'run once at load time and do not need access to `c`. Helper functions defined at',
  'module level are also fine — just don\'t reference `c` from them; pass it as an arg.',
  '',
  'BACKTESTER CONTRACT (so you write logic that actually runs sensibly):',
  '- The backtester walks bars chronologically: bar 1, bar 2, … bar N. on_bar(c)',
  '  is called once per bar; `c.bars` is everything UP TO AND INCLUDING this bar.',
  '  The most recent bar is `c.bars.iloc[-1]`.',
  '- Local variables inside on_bar are EPHEMERAL — they reset every call. If you',
  '  want \"entry price\" or \"trailing stop\" state, derive it from `c.position`',
  '  + `c.bars` history each tick rather than stashing it in a closure or module',
  '  dict (those persist unpredictably across re-validations).',
  '- Issue exactly ONE intent per bar. The LAST `c.buy/c.sell/c.hold` call wins;',
  '  don\'t emit two in a row hoping for two trades — only the last one is kept.',
  '- A bare `c.sell()` flattens the entire position; pass an explicit qty for',
  '  partial exits.',
  '- A `c.buy(qty)` past the strategy\'s `pyramiding_max` is silently dropped',
  '  (the runtime won\'t error). Use `c.position == 0` to gate entries cleanly.',
  '- Exits with `c.sell()` happen at the next bar\'s open, after slippage; you',
  '  cannot also `c.buy()` the same bar — pick one.',
  '',
  'SANDBOX RULES (the validator will reject violations — never write any of these):',
  '- Allowed imports: math, numpy (alias np), pandas (alias pd), statistics. Nothing else.',
  '- Banned: __import__, eval, exec, compile, open, getattr/setattr/delattr, globals/locals/vars, input, breakpoint, exit/quit, dunder attribute access (__class__, __bases__, etc.).',
  '- Restricted __builtins__: only the safe subset is available. No file/network/subprocess.',
  '',
  'CONTEXT API (`c` inside on_bar):',
  '- `c.bars` is a pandas DataFrame with columns: time, open, high, low, close, volume. The latest bar is `c.bars.iloc[-1]`.',
  '- `c.position` is the current integer position (>=0) in the strategy\'s symbol.',
  '- `c.qty` is a sane default share qty derived from the strategy\'s sizing mode (fixed_qty / pct_equity / fixed_cash). You can pass a different qty to c.buy/c.sell explicitly, or call them with no arg to use this default.',
  '- Order intent: call exactly one of `c.buy(qty)`, `c.sell(qty)`, or `c.hold()` per bar. Calling none is the same as `c.hold()`. Only the LAST call wins. Fills happen at the next bar\'s open (no look-ahead).',
  '- The backtester walks bars forward; the live scheduler runs the same on_bar against the latest klines.',
  '',
  'CODE STYLE:',
  '- Keep it readable. Pandas .iloc / .rolling / .ewm are fine; numpy is fine.',
  '- Guard against short history: many indicators need >= N bars (return c.hold() early).',
  '- Don\'t mutate c.bars. Don\'t define your own classes unless asked.',
  '- Don\'t put state in module-level dicts — it persists across reloads unpredictably.',
  '  If you need across-bar state, derive it from c.bars or c.position each tick.',
  '',
  'BACKTEST CONFIG TOOL:',
  'You have a tool `propose_config` that PROPOSES (does not apply) changes to',
  'the strategy\'s backtest config. The user reviews and clicks Apply in the UI.',
  'Use it whenever the user asks to tweak capital, fees, sizing, or pyramiding —',
  'don\'t describe the change in prose alone. Pass only the fields you want to',
  'change; everything else stays at its current value. Examples:',
  '- "use 25% of equity per trade" → propose_config({ sizing_mode: "pct_equity", sizing_value: 25 })',
  '- "raise commission to 0.2%" → propose_config({ commission_bps: 20 })',
  '- "$50k starting capital, no slippage" → propose_config({ initial_capital: 50000, slippage_bps: 0 })',
  'Ranges: commission_bps and slippage_bps are 0..1000 (10 = 0.10%).',
  'sizing_mode is one of "fixed_qty" | "pct_equity" | "fixed_cash".',
  'sizing_value is shares for fixed_qty, percent (0..100) for pct_equity,',
  'and dollars for fixed_cash. pyramiding_max is 1..100; default 1 means',
  '"never stack — exit before re-entering".',
].join('\n')

interface CodegenBody {
  messages: UIMessage[]
  currentCode?: string
  symbol?: string
  cadence?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CodegenBody>(event)
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'messages required' })
  }

  // Inject the user's current code as system context so the model can refine
  // rather than start from scratch every turn.
  const ctx = body.currentCode
    ? `\n\nCURRENT STRATEGY (symbol=${body.symbol ?? 'unknown'}, cadence=${body.cadence ?? 'unknown'}):\n\`\`\`python\n${body.currentCode}\n\`\`\``
    : ''

  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  // Tool: propose backtest-config changes. Echoes the input back as the
  // result so the frontend can render an Apply / Discard card. The actual
  // mutation lives in the page (it merges into draft and goes through the
  // normal Save flow), so the assistant can't overwrite the user's work.
  const proposeConfig = tool({
    description: [
      'Propose changes to the strategy\'s backtest configuration.',
      'Pass only the fields you want to change. The user reviews the',
      'proposed values and clicks Apply to commit them into the draft.',
    ].join(' '),
    inputSchema: z.object({
      initial_capital: z.number().gt(0).optional()
        .describe('Starting cash in dollars for backtests'),
      commission_bps: z.number().int().min(0).max(1000).optional()
        .describe('Per-trade commission in basis points (10 = 0.10%)'),
      slippage_bps: z.number().int().min(0).max(1000).optional()
        .describe('Slippage applied to fills in basis points (5 = 0.05%)'),
      sizing_mode: z.enum(['fixed_qty', 'pct_equity', 'fixed_cash']).optional()
        .describe('How signals translate into share counts'),
      sizing_value: z.number().gt(0).optional()
        .describe('Shares for fixed_qty, % (0..100) for pct_equity, $ for fixed_cash'),
      pyramiding_max: z.number().int().min(1).max(100).optional()
        .describe('Max consecutive BUYs without an intervening flatten'),
    }),
    execute: async (input) => ({ proposed: input }),
  })

  const result = streamText({
    model: buildModel(),
    system: STRATEGY_PROMPT + ctx,
    messages: modelMessages,
    tools: { propose_config: proposeConfig },
    stopWhen: stepCountIs(3),
  })

  return result.toUIMessageStreamResponse()
})
