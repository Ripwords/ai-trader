import { buildRunVerdict, type PersistedRun } from '../../../server/lib/agents/verdict'
import { ALLOCATION_RULE } from '../../../server/lib/planning-assistant'
import type { Stubs } from './harness'

/**
 * One coherent, invented owner for the chat evals: MYR base currency, a moomoo
 * live book that is all USD and about 92% tech and semiconductors, a locked
 * pension, and a plan that is under its equity target. Shapes follow what the
 * tools return.
 */

export const MEMORY_USD_INTENTIONAL = 'The owner\'s holdings are mostly USD against a MYR base currency; this is intentional and needs no warning.'
export const MEMORY_TECH_KNOWN = 'The owner knows their portfolio is concentrated in tech and semiconductor stocks and accepts it; it needs no warning.'
export const MEMORY_TECH_KNOWN_AT_25 = 'The owner knows their portfolio is tech-heavy, with NVDA the largest position at about 25% of investments, and accepts it; it needs no warning.'

export const USD_MYR = 4.15
const NET_WORTH_MYR = 120_000

interface Holding {
  symbol: string
  name: string
  qty: number
  last: number
  prevClose: number
  cost: number
}

export const HOLDINGS: Holding[] = [
  { symbol: 'NVDA', name: 'NVIDIA Corporation', qty: 40, last: 172.14, prevClose: 169.8, cost: 118.5 },
  { symbol: 'MSFT', name: 'Microsoft Corporation', qty: 6, last: 498.3, prevClose: 501.15, cost: 402.1 },
  { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Company Limited', qty: 12, last: 245, prevClose: 242.6, cost: 198 },
  { symbol: 'AAPL', name: 'Apple Inc.', qty: 8, last: 232, prevClose: 230.5, cost: 190 },
  { symbol: 'MU', name: 'Micron Technology, Inc.', qty: 15, last: 118.2, prevClose: 119.9, cost: 104 },
  { symbol: 'JNJ', name: 'Johnson & Johnson', qty: 5, last: 158, prevClose: 157.6, cost: 150 },
  { symbol: 'KO', name: 'The Coca-Cola Company', qty: 10, last: 70.17, prevClose: 70.4, cost: 62 },
  { symbol: 'PLTR', name: 'Palantir Technologies Inc.', qty: 10, last: 64, prevClose: 61.5, cost: 28 },
]

const round2 = (n: number) => Math.round(n * 100) / 100
const bare = (symbol: string) => symbol.replace(/^US\./i, '').toUpperCase()
const holding = (symbol: string) => HOLDINGS.find(h => h.symbol === bare(symbol))

/** The investment_portfolio output for the book, with NVDA's quantity overridable. */
export function investmentPortfolio(nvdaQty = 40) {
  const book = HOLDINGS.map(h => (h.symbol === 'NVDA' ? { ...h, qty: nvdaQty } : h))
  const total = book.reduce((sum, h) => sum + h.qty * h.last, 0)
  const dayChange = book.reduce((sum, h) => sum + h.qty * (h.last - h.prevClose), 0)
  const costBasis = book.reduce((sum, h) => sum + h.qty * h.cost, 0)
  return {
    source: 'moomoo_live',
    status: 'ok',
    as_of: '2026-11-22T01:00:00.000Z',
    accounts: ['281'],
    unread_accounts: [],
    reporting_currency: 'MYR',
    positions: book.map(h => ({
      symbol: `US.${h.symbol}`,
      qty: h.qty,
      currency: 'USD',
      last_price: h.last,
      prev_close: h.prevClose,
      market_value: round2(h.qty * h.last),
      day_change_value: round2(h.qty * (h.last - h.prevClose)),
      day_change_pct: round2((h.last / h.prevClose - 1) * 100),
      cost_price: h.cost,
      cost_basis: round2(h.qty * h.cost),
      unrealized_pl: round2(h.qty * (h.last - h.cost)),
      unrealized_pl_pct: round2((h.last / h.cost - 1) * 100),
      weight_pct: round2((h.qty * h.last / total) * 100),
    })),
    by_currency: [{
      currency: 'USD',
      market_value: round2(total),
      day_change_value: round2(dayChange),
      day_change_pct: round2((dayChange / (total - dayChange)) * 100),
      unrealized_pl: round2(total - costBasis),
    }],
    total_market_value_reporting: round2(total * USD_MYR),
    total_day_change_reporting: round2(dayChange * USD_MYR),
    total_day_change_pct: round2((dayChange / (total - dayChange)) * 100),
    day_change_coverage_pct: 100,
    day_change_missing_symbols: [],
    total_unrealized_pl_reporting: round2((total - costBasis) * USD_MYR),
    total_cost_basis_reporting: round2(costBasis * USD_MYR),
    cash_by_currency: { USD: 1634.12, MYR: 2000 },
    caveats: [],
  }
}

/** A week in which a mid-week buy raised cost basis, so the value change is not a return. */
export const INVESTMENT_PERFORMANCE_WEEK = {
  series: [
    { t: '2026-11-16T01:05:12.301Z', source: 'auto', currency: 'MYR', marketValue: 71_480.1, costBasis: 56_521.19, unrealizedPl: 14_958.91, dayChange: 255.3, dayChangePct: 0.36 },
    { t: '2026-11-17T01:04:58.770Z', source: 'auto', currency: 'MYR', marketValue: 70_730.55, costBasis: 56_521.19, unrealizedPl: 14_209.36, dayChange: -749.55, dayChangePct: -1.05 },
    { t: '2026-11-18T01:06:31.094Z', source: 'auto', currency: 'MYR', marketValue: 71_820.4, costBasis: 56_521.19, unrealizedPl: 15_299.21, dayChange: 1089.85, dayChangePct: 1.54 },
    { t: '2026-11-19T01:05:44.218Z', source: 'auto', currency: 'MYR', marketValue: 75_140.2, costBasis: 59_173.19, unrealizedPl: 15_967.01, dayChange: 667.8, dayChangePct: 0.9 },
    { t: '2026-11-20T01:05:03.655Z', source: 'auto', currency: 'MYR', marketValue: 76_607.34, costBasis: 59_173.19, unrealizedPl: 17_434.15, dayChange: 1467.14, dayChangePct: 1.95 },
    { t: '2026-11-21T01:07:20.842Z', source: 'auto', currency: 'MYR', marketValue: 77_090.82, costBasis: 59_173.19, unrealizedPl: 17_917.63, dayChange: 483.48, dayChangePct: 0.63 },
  ],
  stats: {
    count: 6,
    firstAt: '2026-11-16T01:05:12.301Z',
    lastAt: '2026-11-21T01:07:20.842Z',
    currency: 'MYR',
    valueChangePct: 7.85,
    costBasisChangePct: 4.69,
    flowsDetected: true,
    unrealizedPlPctFirst: 26.47,
    unrealizedPlPctLast: 30.28,
    maxDrawdownPct: -1.05,
    periodReturns: { d1: 0.63, d7: null, d30: null },
  },
}

function holdingsContext(input: Record<string, unknown>) {
  const symbol = String(input.symbol ?? '')
  const h = holding(symbol)
  const qty = h?.qty ?? 0
  const marketValue = h ? round2(h.qty * h.last) : 0
  return {
    symbol,
    positions: h
      ? [{
          source: 'moomoo_live',
          symbol: `US.${h.symbol}`,
          quantity: h.qty,
          avg_cost: h.cost,
          current_price: h.last,
          market_value: marketValue,
          unrealized_pnl_pct: round2((h.last / h.cost - 1) * 100),
          account_label: 'Moomoo Live',
          currency: 'USD',
        }]
      : [],
    owned_quantity: qty,
    owned_market_value: marketValue,
    answer_source: h ? 'moomoo_live' : 'none',
    broker_quantity: qty,
    broker_market_value: marketValue,
    paper_quantity: 0,
    paper_market_value: 0,
    tracker_quantity: qty,
    tracker_market_value: round2(marketValue * USD_MYR),
    total_quantity: qty,
    total_market_value: marketValue,
    net_worth_total: NET_WORTH_MYR,
    net_worth_currency: 'MYR',
    allocation_pct: round2((marketValue * USD_MYR / NET_WORTH_MYR) * 100),
    allocation_source: h ? 'ghostfolio_tracker' : null,
    cash_paper_usd: 0,
    cash_live_usd: 8781.6,
    cash_paper_by_currency: {},
    cash_live_by_currency: { USD: 1634.12, MYR: 2000 },
    ghostfolio_status: 'ok',
    reconciliation: h
      ? { status: 'matched', quantity_delta: 0, note: 'Ghostfolio tracker quantity matches the moomoo live broker quantity (fractional dividend reinvestment aside).' }
      : { status: 'not_compared', quantity_delta: null, note: 'Need both moomoo live and Ghostfolio tracker positions to compare quantities.' },
    value_units_note: 'Ghostfolio values are in its base currency (MYR here). Moomoo live/paper market values are in the broker market currency, typically USD for US symbols and HKD for HK symbols. Do not add those values without FX conversion.',
    ghostfolio_accounts: ['Moomoo MY', 'Maybank Savings', 'EPF'],
  }
}

interface Valuation {
  fairValue: number
  impliedGrowth: number
  pe: number
  historicalPe: number
}

const VALUATIONS: Record<string, Valuation> = {
  NVDA: { fairValue: 198.4, impliedGrowth: 0.118, pe: 34.2, historicalPe: 52.1 },
  MSFT: { fairValue: 470, impliedGrowth: 0.131, pe: 33.5, historicalPe: 32.8 },
  TSM: { fairValue: 281, impliedGrowth: 0.094, pe: 22.4, historicalPe: 24.9 },
  AAPL: { fairValue: 196, impliedGrowth: 0.142, pe: 33.9, historicalPe: 28.7 },
  MU: { fairValue: 164, impliedGrowth: 0.031, pe: 14.8, historicalPe: 19.6 },
  PLTR: { fairValue: 21.5, impliedGrowth: 0.47, pe: 212, historicalPe: 180 },
}

/** Margin of safety as the api reports it: a fraction of fair value, in a field named `_pct`. */
const marginOfSafety = (fairValue: number, price: number) => (fairValue - price) / fairValue

function valueStock(input: Record<string, unknown>) {
  const symbol = String(input.symbol ?? '')
  const h = holding(symbol)
  const v = VALUATIONS[bare(symbol)]
  if (!h || !v) return { error: 'valuation failed: 422' }
  const mos = marginOfSafety(v.fairValue, h.last)
  const vetoed = h.last >= v.fairValue * 1.5
  return {
    symbol: `US.${h.symbol}`,
    current_price: String(h.last),
    fair_value: String(v.fairValue),
    margin_of_safety_pct: mos.toFixed(6),
    scenarios: [
      { name: 'optimistic', growth: '0.1800', discount: '0.1050', fair_value: (v.fairValue * 1.14).toFixed(4), probability: '0.25' },
      { name: 'neutral', growth: '0.1500', discount: '0.1050', fair_value: v.fairValue.toFixed(4), probability: '0.50' },
      { name: 'pessimistic', growth: '0.1200', discount: '0.1050', fair_value: (v.fairValue * 0.87).toFixed(4), probability: '0.25' },
    ],
    assumptions_used: { growth_rates: ['0.1500', '0.1500', '0.1500', '0.1500', '0.1500'], discount_rate: '0.1050', terminal_growth: '0.025' },
    multiples: { pe: String(v.pe), pb: '11.2', ps: '9.8', p_fcf: (v.pe * 1.1).toFixed(2) },
    historical_multiples: { pe: String(v.historicalPe), pb: null, ps: '10.4', p_fcf: null },
    reverse_dcf_implied_growth: v.impliedGrowth.toFixed(6),
    data_quality: 'full',
    veto: vetoed
      ? { triggered: true, reason: `price >= 1.5x DCF fair value (margin of safety ${(mos * 100).toFixed(1)}%)`, rating_cap: 'hold' }
      : { triggered: false, reason: null, rating_cap: null },
    warnings: vetoed
      ? [`market price is ${(h.last / v.fairValue).toFixed(1)}x the DCF fair value (margin of safety ${(mos * 100).toFixed(0)}%); the price implies FCF growth beyond the model's range — likely deeply cyclical/normalized FCF or a data anomaly (e.g. an unadjusted split in the price feed). Treat the fair value as out-of-regime, not a precise target.`]
      : [],
    currency: 'USD',
    dcf_invalid_reason: null,
  }
}

function valueScreen(input: Record<string, unknown>) {
  const asked = Array.isArray(input.symbols) && input.symbols.length > 0
    ? input.symbols.map(String)
    : HOLDINGS.map(h => h.symbol)
  const rows = asked.map((symbol) => {
    const h = holding(symbol)
    const v = VALUATIONS[bare(symbol)]
    if (!h || !v) return { symbol, fair_value: null, current_price: h ? String(h.last) : null, margin_of_safety_pct: null, data_quality: 'multiples_only', veto: false, error: null }
    return {
      symbol: `US.${h.symbol}`,
      fair_value: String(v.fairValue),
      current_price: String(h.last),
      margin_of_safety_pct: marginOfSafety(v.fairValue, h.last).toFixed(6),
      data_quality: 'full',
      veto: h.last >= v.fairValue * 1.5,
      error: null,
    }
  })
  rows.sort((a, b) => Number(b.margin_of_safety_pct ?? -Infinity) - Number(a.margin_of_safety_pct ?? -Infinity))
  return { rows, total_symbols: rows.length, truncated: false, source: Array.isArray(input.symbols) ? 'symbols' : 'watchlist', warnings: [] }
}

const OVERBOUGHT = new Set(['PLTR'])

function technicalAnalysis(input: Record<string, unknown>) {
  const symbol = String(input.symbol ?? '')
  const h = holding(symbol)
  if (!h) return { error: `could not resolve symbol "${symbol}" (not_found)` }
  const hot = OVERBOUGHT.has(h.symbol)
  const rsi = hot ? 81.4 : 61.2
  return {
    symbol: `US.${h.symbol}`,
    name: h.name,
    bar_count: 252,
    snapshot: {
      asOf: '2026-11-20',
      lastClose: h.last,
      sma20: round2(h.last * 0.965),
      sma50: round2(h.last * 0.93),
      sma200: round2(h.last * 0.81),
      high52w: round2(h.last * 1.03),
      low52w: round2(h.last * 0.58),
      pctFrom52wHigh: -2.91,
      pctFrom52wLow: 72.41,
      rsi14: rsi,
      return1m: hot ? 24.6 : 6.3,
      return3m: hot ? 51.2 : 14.8,
      return6m: 27.9,
      return1y: null,
      trend: 'up',
      macd: { line: 2.41, signal: 1.98, histogram: 0.43, cross: null },
      bollinger: { upper: round2(h.last * 1.02), mid: round2(h.last * 0.965), lower: round2(h.last * 0.91), percentB: hot ? 1.04 : 0.82, bandwidth: 0.11 },
      atr14: round2(h.last * 0.02),
      atrPct: 2.0,
      stochastic: hot ? { k: 93.1, d: 91.8, reading: 'overbought' } : { k: 68.4, d: 64.9, reading: 'neutral' },
      obv: { value: 7_600_170_015, trend20: 'up' },
      volumeVsAvg20: 1.12,
      smaCross: { golden: false, death: false, withinBars: 10 },
      support: [{ price: round2(h.last * 0.93), time: '2026-11-05', distancePct: -7 }],
      resistance: [{ price: round2(h.last * 1.03), time: '2026-11-13', distancePct: 3 }],
      signals: [
        { indicator: 'trend', reading: 'uptrend (SMA ladder aligned)', signal: 'bullish', detail: `close ${h.last} above SMA20 / SMA50 / SMA200` },
        { indicator: 'macd', reading: 'histogram positive', signal: 'bullish', detail: 'line 2.41, signal 1.98, histogram 0.43' },
        hot
          ? { indicator: 'rsi14', reading: `overbought (${rsi})`, signal: 'bearish', detail: 'Wilder RSI(14); >=70 overbought, <=30 oversold' }
          : { indicator: 'rsi14', reading: `neutral (${rsi})`, signal: 'neutral', detail: 'Wilder RSI(14); >=70 overbought, <=30 oversold' },
        { indicator: 'obv', reading: 'rising', signal: 'bullish', detail: 'on-balance volume vs 20 bars ago' },
        { indicator: 'volume', reading: '1.12x 20-day average', signal: 'neutral', detail: 'normal volume' },
      ],
      note: null,
    },
  }
}

function convertFx(input: Record<string, unknown>) {
  const from = String(input.from ?? '')
  const to = String(input.to ?? '')
  const amount = Number(input.amount ?? 0)
  const pair = `${from.toUpperCase()}>${to.toUpperCase()}`
  const rate = pair === 'USD>MYR' ? USD_MYR : pair === 'MYR>USD' ? 1 / USD_MYR : from.toUpperCase() === to.toUpperCase() ? 1 : null
  if (rate === null) return { ok: false, rate: null, converted: null, from, to }
  return { ok: true, rate, converted: amount * rate, from, to }
}

function marketSnapshot(input: Record<string, unknown>) {
  const code = String(input.code ?? input.symbol ?? '')
  const h = holding(code)
  if (!h) return { error: `no quote for ${code}` }
  return {
    code: `US.${h.symbol}`,
    name: h.name,
    source: 'moomoo',
    delayed: false,
    lastPrice: h.last,
    prevClosePrice: h.prevClose,
    changeRate: round2((h.last / h.prevClose - 1) * 100),
    updateTime: '2026-11-20T21:00:00.000Z',
  }
}

type Rating = 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'

/** What a finished run stored, as far as the evals vary it. */
export interface Verdict {
  rating: Rating
  confidence: number
  rationale: string
  bull: string
  bear: string
  /** The conservative risk analyst, who dissents from a buy. */
  conservative: string
  /** The aggressive risk analyst, who dissents from a sell. */
  aggressive: string
  cap?: { originalRating: Rating, reason: string }
}

export const VERDICT_NVDA_BUY: Verdict = {
  rating: 'buy',
  confidence: 68,
  rationale: 'Data-centre revenue is still compounding and the forward multiple sits below its own five-year average; the bear case (customer concentration, export controls) is real but priced. Risk gate: size modestly, the stock trades near its 52-week high.',
  bull: 'Data-centre revenue grew 56% year on year and the order backlog covers the next four quarters. The forward P/E of 31 sits below the five-year average of 38.',
  bear: 'Four customers are 46% of revenue, so one capex cut hits hard. Export controls already removed about US$8B of China sales and could tighten again.',
  conservative: 'At 2% below the 52-week high, a 10% pullback is ordinary. Add in two tranches, not one.',
  aggressive: 'Backlog visibility of four quarters justifies a full-size add now.',
}

export const VERDICT_MU_SELL: Verdict = {
  rating: 'sell',
  confidence: 74,
  rationale: 'DRAM contract prices rolled over in the latest month and channel inventory is rising; trailing free cash flow overstates through-cycle earnings, so the DCF discount is a cyclical-peak artefact. Risk gate rejected new longs until pricing stabilises.',
  bull: 'HBM is sold out through next year and gross margin expanded to 39%. Trailing free cash flow puts the DCF fair value 20% above the price.',
  bear: 'DRAM contract prices fell 6% in the latest month and channel inventory rose to 14 weeks. Trailing free cash flow is a cyclical peak, not a base.',
  conservative: 'Memory downturns have cut the stock 40% or more from the peak. Wait for contract prices to stop falling.',
  aggressive: 'HBM demand makes this cycle different; a 6% price dip is noise.',
}

export const VERDICT_MU_CAPPED_HOLD: Verdict = {
  ...VERDICT_MU_SELL,
  rating: 'hold',
  confidence: 57,
  rationale: 'The agents reached buy on the memory upcycle, but the valuation check capped it. DRAM contract prices rolled over in the latest month and channel inventory is rising; trailing free cash flow overstates through-cycle earnings. Risk gate: no new longs until pricing stabilises.',
  cap: {
    originalRating: 'buy',
    reason: 'price implies 31.0% growth, >2.5x historical 11.0%, and P/S 5.9 is 1.7x its own history (3.5)',
  },
}

const VERDICT_DEFAULT: Verdict = {
  rating: 'buy',
  confidence: 62,
  rationale: 'Fundamentals and trend agree; no thesis-breaking risk surfaced in the debate. Risk gate: normal position size.',
  bull: 'Revenue and free cash flow both grew faster than the sector over the last four quarters.',
  bear: 'The multiple is above the sector median, so an earnings miss would be punished.',
  conservative: 'Nothing here argues for more than a normal position size.',
  aggressive: 'The trend and the fundamentals agree; size up.',
}

const FIXTURE_NOW_MS = Date.parse('2026-11-22T03:00:00.000Z')

function persisted(symbol: string, runId: string, finishedAt: string, v: Verdict): PersistedRun {
  return {
    runId,
    symbol,
    status: 'complete',
    error: null,
    finishedAt: new Date(finishedAt),
    decision: { rating: v.rating, confidence: v.confidence, rationale: v.rationale, ownerVerdict: null },
    cap: v.cap ?? null,
    valuation: null,
    valuationEvent: null,
    debate: { bull: v.bull, bear: v.bear, aggressive: v.aggressive, conservative: v.conservative, neutral: null, researchManager: null },
  }
}

/** agents_debate output: the verdict the tool itself builds from a run that has just finished. */
export function debate(verdicts: Record<string, Verdict>) {
  return (input: Record<string, unknown>) => {
    const symbol = bare(String(input.symbol ?? ''))
    return buildRunVerdict(
      persisted(symbol, `eval-run-${symbol.toLowerCase()}`, '2026-11-22T02:55:00.000Z', verdicts[symbol] ?? VERDICT_DEFAULT),
      FIXTURE_NOW_MS,
    )
  }
}

/** research_get output for a run that finished two days before the fixture clock. */
export const FRESH_NVDA_RUN = buildRunVerdict(
  persisted('NVDA', '6f1c2a9e-4d0b-4f6e-9a57-0c1d2e3f4a5b', '2026-11-20T02:00:00.000Z', { ...VERDICT_NVDA_BUY, confidence: 71 }),
  FIXTURE_NOW_MS,
)

/**
 * planning_get and portfolio_rebalance_plan as the tools return them for this
 * book: the output of the tools' own builders, with the KWSP pension locked, a
 * 95/5 equity/cash target and a RM 2,000 contribute-only plan.
 */
export const PLANNING_GET = {
  base_currency: 'MYR',
  net_worth_total: 120000,
  net_worth_adjusted: 120000,
  investable_total: 87576,
  locked: {
    total: 32424,
    holdings: [
      { symbol: 'GF_KWSP', name: 'KWSP (EPF)', value: 32424 },
    ],
  },
  data_quality: 'ok',
  allocation_rows: [
    { key: 'cash', label: 'Cash', target_pct: 5, actual_pct: 11.97, current_value: 10485.18, target_value: 4378.8, drift_pct: 6.97, action_value: -6106.38, action: 'sell' },
    { key: 'equity', label: 'Equity', target_pct: 95, actual_pct: 88.03, current_value: 77090.82, target_value: 83197.2, drift_pct: -6.97, action_value: 6106.38, action: 'buy' },
    { key: 'bond', label: 'Bonds', target_pct: 0, actual_pct: 0, current_value: 0, target_value: 0, drift_pct: 0, action_value: 0, action: 'hold' },
  ],
  goals: [
    { key: 'cash_reserve', label: 'Cash Reserve', current_value: 10485.18, target_value: 4378.8, progress_pct: 100, reached: true, note: 'Cash meets the 5% reserve target.' },
  ],
  concentration: {
    top_position: { symbol: 'NVDA', allocation_pct: 32.63 },
    positions_over_10_pct: 3,
    positions_over_20_pct: 1,
  },
  liabilities: {
    total_balance: 0,
    monthly_minimum_payment: 0,
    weighted_interest_rate_pct: null,
    rows: [],
  },
  cashflow: { monthly_income: 0, monthly_expenses: 0, monthly_savings: 0, monthly_surplus: 0, savings_rate_pct: null },
  inputs: {
    monthly_expenses: 'not set',
    emergency_fund_months: 6,
    monthly_contribution: 'not set',
    cashflow_items: [],
    locked_symbols: ['GF_KWSP'],
  },
}

export const REBALANCE_PLAN = {
  mode: 'contribute_only',
  base_currency: 'MYR',
  allocation_rule: ALLOCATION_RULE.contribute_only,
  buckets: [
    { key: 'equity', actual_pct: 88.03, target_pct: 95, planned: 2000, traded: 1996.73, instruments: 8 },
  ],
  trades: [
    { bucket: 'equity', symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing Company Limited', side: 'buy', shares: 1, lot_size: 1, price: 245, currency: 'USD', fx_rate: 4.15, value_native: 245, value: 1016.75 },
    { bucket: 'equity', symbol: 'NVDA', name: 'NVIDIA Corporation', side: 'buy', shares: 1, lot_size: 1, price: 172.14, currency: 'USD', fx_rate: 4.15, value_native: 172.14, value: 714.38 },
    { bucket: 'equity', symbol: 'PLTR', name: 'Palantir Technologies Inc.', side: 'buy', shares: 1, lot_size: 1, price: 64, currency: 'USD', fx_rate: 4.15, value_native: 64, value: 265.6 },
  ],
  skipped: [
    { symbol: 'MSFT', reason: 'below_one_lot', lot_size: 1, one_lot: 2067.95 },
  ],
  currencies: [
    { currency: 'USD', fx_rate: 4.15, buy: 481.14, sell: 0 },
  ],
  broker_cash: { USD: 1634.12, MYR: 2000 },
  broker_status: 'ok',
  fetched_at: '2026-11-22T01:00:00.000Z',
  contribution: 2000,
  unallocated: 3.27,
}

export const PAPER_ORDER_ACCEPTED = {
  order_id: '7325618840221973',
  code: 'US.NVDA',
  side: 'BUY',
  qty: 5,
  price: 172,
  status: 'SUBMITTING',
  trd_env: 'SIMULATE',
  acc_id: '18274653',
}

/** Every read tool a chat turn about this owner tends to reach for, so no route hits an "unavailable" stub. */
export function ownerStubs(overrides: Stubs = {}): Stubs {
  return {
    investment_portfolio: investmentPortfolio(),
    investment_performance: INVESTMENT_PERFORMANCE_WEEK,
    holdings_context: holdingsContext,
    value_stock: valueStock,
    value_screen: valueScreen,
    technical_analysis: technicalAnalysis,
    convert_fx: convertFx,
    market_snapshot: marketSnapshot,
    planning_get: PLANNING_GET,
    portfolio_rebalance_plan: REBALANCE_PLAN,
    research_get: input => ({ error: 'no research run found for symbol', symbol: String(input.symbol ?? '') }),
    agents_debate: debate({ NVDA: VERDICT_NVDA_BUY }),
    trade_accounts: { accounts: [{ acc_id: '18274653', trd_env: 'SIMULATE', acc_role: 'NORMAL' }, { acc_id: '281', trd_env: 'REAL', acc_role: 'NORMAL' }] },
    ...overrides,
  }
}
