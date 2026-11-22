import type { Stubs } from './harness'

/**
 * One coherent, invented owner for the chat evals: MYR base currency, a moomoo
 * live book that is all USD and about 92% tech and semiconductors, and a plan
 * that is far under its equity target. Shapes follow what the tools return;
 * the planning outputs keep the severity flags the real tools emit.
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

const HOLDINGS: Holding[] = [
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

export interface Verdict {
  rating: 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'
  confidence: number
  rationale: string
}

export const VERDICT_NVDA_BUY: Verdict = {
  rating: 'buy',
  confidence: 68,
  rationale: 'Data-centre revenue is still compounding and the forward multiple sits below its own five-year average; the bear case (customer concentration, export controls) is real but priced. Risk gate: size modestly, the stock trades near its 52-week high.',
}

export const VERDICT_MU_SELL: Verdict = {
  rating: 'sell',
  confidence: 74,
  rationale: 'DRAM contract prices rolled over in the latest month and channel inventory is rising; trailing free cash flow overstates through-cycle earnings, so the DCF discount is a cyclical-peak artefact. Risk gate rejected new longs until pricing stabilises.',
}

const VERDICT_DEFAULT: Verdict = {
  rating: 'buy',
  confidence: 62,
  rationale: 'Fundamentals and trend agree; no thesis-breaking risk surfaced in the debate. Risk gate: normal position size.',
}

/** agents_debate output: the verdict for the symbol asked about, in the shape of the tool's final yield. */
export function debate(verdicts: Record<string, Verdict>) {
  return (input: Record<string, unknown>) => {
    const symbol = bare(String(input.symbol ?? ''))
    return {
      runId: `eval-run-${symbol.toLowerCase()}`,
      events: ['Market Analyst', 'Fundamentals Analyst', 'News Analyst', 'Bull Researcher', 'Bear Researcher', 'Research Manager', 'Trader', 'Risk Judge']
        .map(node => ({ type: 'node-start', node })),
      ...(verdicts[symbol] ?? VERDICT_DEFAULT),
    }
  }
}

export const FRESH_NVDA_RUN = {
  runId: '6f1c2a9e-4d0b-4f6e-9a57-0c1d2e3f4a5b',
  symbol: 'NVDA',
  status: 'complete',
  finishedAt: '2026-11-20T02:00:00.000Z',
  rating: 'buy',
  confidence: 71,
  rationale: VERDICT_NVDA_BUY.rationale,
  age_days: 2,
}

/**
 * planning_get and portfolio_rebalance_plan as the tools returned them for a
 * real "what should I buy this month" turn (amounts changed, shape and flags
 * kept), including the `critical` concentration flag on the pension fund.
 */
const ALLOCATION_ROWS = [
  { key: 'cash', label: 'Cash', action: 'sell', severity: 'ok', drift_pct: 2.17, actual_pct: 12.17, target_pct: 10, action_value: -2604, target_value: 12_000, current_value: 14_604 },
  { key: 'equity', label: 'Equity', action: 'buy', severity: 'alert', drift_pct: -37.65, actual_pct: 47.35, target_pct: 85, action_value: 45_180, target_value: 102_000, current_value: 56_820 },
  { key: 'bond', label: 'Bonds', action: 'sell', severity: 'alert', drift_pct: 31.45, actual_pct: 36.45, target_pct: 5, action_value: -37_740, target_value: 6000, current_value: 43_740 },
  { key: 'commodity', label: 'Commodities', action: 'sell', severity: 'watch', drift_pct: 4.03, actual_pct: 4.03, target_pct: 0, action_value: -4836, target_value: 0, current_value: 4836 },
]

const TARGET_MODEL = [
  { key: 'cash', label: 'Cash', target_pct: 10 },
  { key: 'equity', label: 'Equity', target_pct: 85 },
  { key: 'bond', label: 'Bonds', target_pct: 5 },
]

export const PLANNING_GET = {
  summary: {
    goals: [
      { key: 'cash_reserve', note: 'Cash meets the 10% reserve target.', label: 'Cash Reserve', status: 'complete', progress_pct: 100, target_value: 12_000, current_value: 14_604 },
      { key: 'monthly_contribution', note: 'Set a monthly contribution to project progress against goals.', label: 'Monthly Contribution', status: 'behind', progress_pct: 0, target_value: 12_000, current_value: 0 },
      { key: 'concentration', note: '1 position above the 20% critical threshold.', label: 'Concentration Control', status: 'behind', progress_pct: 0, target_value: 0, current_value: 1 },
    ],
    cashflow: { monthly_income: 0, monthly_savings: 0, monthly_surplus: 0, monthly_expenses: 0, savings_rate_pct: null },
    cash_total: 8781.6,
    assumptions: { monthly_expenses: 0, monthly_contribution: 0, emergency_fund_months: 6 },
    liabilities: { rows: [], total_balance: 0, monthly_minimum_payment: 0, weighted_interest_rate_pct: null },
    data_quality: 'ok',
    target_model: TARGET_MODEL,
    base_currency: 'MYR',
    concentration: {
      top_position: { symbol: 'GF_KWSP', severity: 'critical', allocation_pct: 27.02 },
      positions_over_10_pct: 1,
      positions_over_20_pct: 1,
    },
    allocation_rows: ALLOCATION_ROWS,
    net_worth_total: NET_WORTH_MYR,
    positions_value: 109_380,
    rebalance_actions: ALLOCATION_ROWS.filter(row => row.key !== 'cash'),
    net_worth_adjusted: NET_WORTH_MYR,
  },
  settings: {
    liabilities: [],
    target_model: TARGET_MODEL,
    cashflow_items: [],
    monthly_expenses: 0,
    monthly_contribution: 0,
    emergency_fund_months: 6,
  },
}

const REBALANCE_BUYS: Array<[symbol: string, name: string, value: number, approxQuantity: number | null]> = [
  ['MSFT', 'Microsoft Corporation', 290, null],
  ['AAPL', 'Apple Inc.', 285.5, null],
  ['NVDA', 'NVIDIA Corporation', 281.25, null],
  ['TSM', 'Taiwan Semiconductor Manufacturing Company Limited', 277.75, null],
  ['MU', 'Micron Technology, Inc.', 242, null],
  ['JNJ', 'Johnson & Johnson', 187, null],
  ['GOOG', 'Alphabet Inc.', 115, null],
  ['KO', 'The Coca-Cola Company', 105, null],
  ['1066.KL', 'RHB Bank Berhad', 100.5, 13.49],
  ['CVX', 'Chevron Corporation', 96, null],
  ['PLTR', 'Palantir Technologies Inc.', 20, null],
]

export const REBALANCE_PLAN = {
  mode: 'contribute_only',
  trades: REBALANCE_BUYS.map(([symbol, name, value, approx_quantity]) => ({ name, side: 'buy', value, bucket: 'equity', symbol, approx_quantity })),
  cash_change: 0,
  base_currency: 'MYR',
  allocation_rows: ALLOCATION_ROWS,
  unallocated_contribution: 0,
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
