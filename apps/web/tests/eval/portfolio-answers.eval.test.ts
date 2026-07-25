import { generateText, stepCountIs, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'
import { buildModel } from '../../server/llm/model'
import { makeTools } from '../../server/llm/tools'
import type { ApiClient } from '../../server/llm/http'

/**
 * Golden-question eval suite for portfolio answers.
 *
 * This is the part of the harness that guards the ANSWER, not the data. The
 * regression it exists for:
 *
 *   "Your portfolio barely flinched — net worth went from RM 140,712 to
 *    RM 140,654, a drop of just -0.04% overnight."
 *
 * That was a net-worth delta narrated as investment performance, while the
 * actual moomoo positions had moved far more. Tiers 1 and 2 (tests/unit) pin
 * the data and the prompt; this tier pins what the model actually says.
 *
 * Opt-in — costs real tokens:
 *   EVAL_LLM=1 npx vitest run tests/eval
 *
 * Verified teeth (run against the pre-fix commit 0677bae, old prompt + no
 * investment_portfolio tool): the first two cases FAIL, and the overnight case
 * routes to portfolio_performance — reproducing the original bug exactly. The
 * currency and unavailable cases passed even pre-fix, so treat them as
 * guards against reintroduction rather than as reproductions of it.
 */

const ENABLED = process.env.EVAL_LLM === '1'
const d = ENABLED ? describe : describe.skip

// --- Fixtures -------------------------------------------------------------
// Numbers are deliberately distinctive so assertions can tell which layer the
// model drew from. The investments layer moved -2.13%; net worth moved -0.04%.

const NET_WORTH_YESTERDAY = 140_712
const NET_WORTH_TODAY = 140_654

const NET_WORTH_HISTORY = {
  series: [
    { t: '2026-07-24T00:00:00.000Z', source: 'auto', netWorth: NET_WORTH_YESTERDAY, cash: 78_000, positionsValue: 62_712, currency: 'MYR' },
    { t: '2026-07-25T00:00:00.000Z', source: 'auto', netWorth: NET_WORTH_TODAY, cash: 78_000, positionsValue: 62_654, currency: 'MYR' },
  ],
  stats: {
    count: 2,
    firstAt: '2026-07-24T00:00:00.000Z',
    lastAt: '2026-07-25T00:00:00.000Z',
    currency: 'MYR',
    totalReturnPct: -0.04,
    maxDrawdownPct: -0.04,
    periodReturns: { d1: -0.04, d7: null, d30: null },
  },
}

const MIXED_INVESTMENTS = {
  source: 'moomoo_live',
  status: 'ok',
  as_of: '2026-07-25T01:00:00.000Z',
  accounts: ['281'],
  reporting_currency: 'MYR',
  positions: [
    {
      symbol: 'US.NVDA', qty: 40, currency: 'USD', last_price: 172.5, prev_close: 178.2,
      market_value: 6900, day_change_value: -228, day_change_pct: -3.2,
      cost_price: 140, cost_basis: 5600, unrealized_pl: 1300, unrealized_pl_pct: 23.21,
      weight_pct: 47.4,
    },
    {
      symbol: 'HK.00700', qty: 300, currency: 'HKD', last_price: 552, prev_close: 549,
      market_value: 165_600, day_change_value: 900, day_change_pct: 0.55,
      cost_price: 480, cost_basis: 144_000, unrealized_pl: 21_600, unrealized_pl_pct: 15,
      weight_pct: 52.6,
    },
  ],
  by_currency: [
    { currency: 'USD', market_value: 6900, day_change_value: -228, day_change_pct: -3.2, unrealized_pl: 1300 },
    { currency: 'HKD', market_value: 165_600, day_change_value: 900, day_change_pct: 0.55, unrealized_pl: 21_600 },
  ],
  total_market_value_reporting: 62_654,
  total_day_change_reporting: -1364,
  total_day_change_pct: -2.13,
  total_unrealized_pl_reporting: 9_580,
  cash_by_currency: { USD: 1634.12 },
  caveats: [],
}

const USD_ONLY_INVESTMENTS = {
  ...MIXED_INVESTMENTS,
  positions: [MIXED_INVESTMENTS.positions[0]],
  by_currency: [MIXED_INVESTMENTS.by_currency[0]],
  total_market_value_reporting: 30_360,
  total_day_change_reporting: -1003,
  total_day_change_pct: -3.2,
  total_unrealized_pl_reporting: 5_720,
}

const UNAVAILABLE_INVESTMENTS = {
  source: 'moomoo_live',
  status: 'unavailable',
  as_of: '2026-07-25T01:00:00.000Z',
  accounts: [],
  reporting_currency: 'MYR',
  positions: [],
  by_currency: [],
  total_market_value_reporting: null,
  total_day_change_reporting: null,
  total_day_change_pct: null,
  total_unrealized_pl_reporting: null,
  cash_by_currency: {},
  caveats: [
    'No usable moomoo live (REAL, non-IPO) account is available, so the investments layer cannot be read. Do not substitute net worth for this.',
  ],
}

// --- Harness --------------------------------------------------------------

/**
 * Real tool descriptions and the real system prompt; only the data is stubbed.
 * Routing is therefore tested against exactly what ships.
 */
function evalTools(overrides: Record<string, unknown>) {
  const real = makeTools({} as ApiClient) as Record<string, {
    description?: string
    inputSchema: Parameters<typeof tool>[0]['inputSchema']
  }>
  const out: Record<string, unknown> = {}
  for (const [name, def] of Object.entries(real)) {
    const stub = overrides[name]
    out[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async () => stub ?? { error: `${name} is not available in this eval` },
    })
  }
  return out
}

interface AnswerResult {
  text: string
  toolNames: string[]
}

async function ask(question: string, overrides: Record<string, unknown>): Promise<AnswerResult> {
  const result = await generateText({
    model: buildModel(),
    system: buildSystemPrompt('ok'),
    prompt: question,
    tools: evalTools(overrides) as never,
    stopWhen: stepCountIs(6),
  })
  const toolNames = result.steps.flatMap(s => s.toolCalls.map(c => c.toolName))
  return { text: result.text, toolNames }
}

/** Strips thousands separators so "140,654" and "140654" both match. */
function digits(text: string): string {
  return text.replace(/[,\s_]/g, '')
}

d('golden portfolio questions', () => {
  it('has an API key configured', () => {
    expect(
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
        || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.DEEPSEEK_API_KEY,
      'EVAL_LLM=1 needs a provider API key in the environment',
    ).toBeTruthy()
  })

  it('"check my portfolio" reads the investments layer, not net worth', async () => {
    const { text, toolNames } = await ask('check my portfolio', {
      investment_portfolio: MIXED_INVESTMENTS,
      portfolio_performance: NET_WORTH_HISTORY,
    })

    expect(toolNames).toContain('investment_portfolio')
    // The exact regression: quoting the net-worth figures as the answer.
    expect(digits(text)).not.toContain(String(NET_WORTH_TODAY))
    expect(digits(text)).not.toContain(String(NET_WORTH_YESTERDAY))
    expect(text).not.toMatch(/-?0\.04\s*%/)
    // It should name the layer it used.
    expect(text.toLowerCase()).toMatch(/moomoo|investment|position|holding/)
  })

  it('"how did my portfolio do overnight" reports the investments day change', async () => {
    const { text, toolNames } = await ask('how did my portfolio do overnight?', {
      investment_portfolio: MIXED_INVESTMENTS,
      portfolio_performance: NET_WORTH_HISTORY,
    })

    expect(toolNames).toContain('investment_portfolio')
    // The real move, not the diluted one.
    expect(text).toMatch(/2\.1/)
    expect(text).not.toMatch(/-?0\.04\s*%/)
  })

  it('"what is my portfolio worth" never invents HKD for a USD-only book', async () => {
    const { text } = await ask('what is my portfolio worth right now?', {
      investment_portfolio: USD_ONLY_INVESTMENTS,
      portfolio_performance: NET_WORTH_HISTORY,
    })

    // Reporting currency is MYR and the only holding settles in USD; HKD is
    // the currency the old prompt hallucinated.
    expect(text).not.toMatch(/\bHKD\b|HK\$/)
    expect(text).toMatch(/\bMYR\b|RM\s?\d|\bUSD\b|US\$|\$\d/)
  })

  it('"what is my net worth" uses the net-worth layer and labels it', async () => {
    const { text, toolNames } = await ask('what is my net worth?', {
      investment_portfolio: MIXED_INVESTMENTS,
      portfolio_performance: NET_WORTH_HISTORY,
    })

    expect(toolNames).toContain('portfolio_performance')
    expect(digits(text)).toContain(String(NET_WORTH_TODAY))
    expect(text.toLowerCase()).toContain('net worth')
  })

  it('says the investments layer is unavailable instead of substituting net worth', async () => {
    const { text } = await ask('check my portfolio', {
      investment_portfolio: UNAVAILABLE_INVESTMENTS,
      portfolio_performance: NET_WORTH_HISTORY,
    })

    expect(text.toLowerCase()).toMatch(/unavailable|can'?t|cannot|couldn'?t|not able|offline/)
    // Must not quietly answer with the other layer's number.
    expect(digits(text)).not.toContain(String(NET_WORTH_TODAY))
  })
})
