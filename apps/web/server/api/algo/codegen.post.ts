/**
 * Streaming endpoint for the strategy-authoring assistant on /algo/[id].
 *
 * Differs from /api/chat: no thread persistence (these conversations are
 * scratch), no tools (this is a code-writing surface, not an action surface),
 * tightly-scoped system prompt that documents the sandbox DSL so the model
 * doesn't suggest disallowed imports.
 */
import { convertToModelMessages, streamText, type UIMessage } from 'ai'
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
  'SANDBOX RULES (the validator will reject violations — never write any of these):',
  '- Allowed imports: math, numpy (alias np), pandas (alias pd), statistics. Nothing else.',
  '- Banned: __import__, eval, exec, compile, open, getattr/setattr/delattr, globals/locals/vars, input, breakpoint, exit/quit, dunder attribute access (__class__, __bases__, etc.).',
  '- Restricted __builtins__: only the safe subset is available. No file/network/subprocess.',
  '',
  'STRATEGY SHAPE:',
  '- Define a top-level function `on_bar(c)`. The runtime calls it once per bar.',
  '- `c.bars` is a pandas DataFrame with columns: time, open, high, low, close, volume. The latest bar is `c.bars.iloc[-1]`.',
  '- `c.position` is the current integer position (>=0) in the strategy\'s symbol.',
  '- `c.qty` is a sane default share qty derived from the strategy\'s sizing mode (fixed_qty / pct_equity / fixed_cash). You can pass a different qty to c.buy/c.sell explicitly, or call them with no arg to use this default.',
  '- Order intent: call exactly one of `c.buy(qty)`, `c.sell(qty)`, or `c.hold()` per bar. Calling none is the same as `c.hold()`. Only the LAST call wins. Fills happen at the next bar\'s open (no look-ahead).',
  '- The backtester walks bars forward; the live scheduler runs the same on_bar against the latest klines.',
  '',
  'CODE STYLE:',
  '- Keep it readable. Pandas .iloc / .rolling / .ewm are fine; numpy is fine.',
  '- Guard against short history: many indicators need >= N bars.',
  '- Don\'t mutate c.bars. Don\'t define your own classes unless asked.',
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

  const result = streamText({
    model: buildModel(),
    system: STRATEGY_PROMPT + ctx,
    messages: modelMessages,
  })

  return result.toUIMessageStreamResponse()
})
