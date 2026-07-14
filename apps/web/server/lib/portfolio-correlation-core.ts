import type { FullPortfolio } from './holdings'
import type { DailyBar } from './yahoo'

/**
 * Converts an amount between currencies. Returns the original amount unchanged
 * when from === to or when a rate can't be resolved (best-effort — better a
 * slightly-off weight than a zeroed one). Injectable for tests.
 */
export type FxConverter = (amount: number, from: string, to: string) => Promise<number>

// getFxRate is imported lazily so this module stays free of yahoo.ts's
// Nuxt auto-import (defineCachedFunction) dependency at eval time.
const defaultFxConverter: FxConverter = async (amount, from, to) => {
  if (!amount || from === to) return amount
  const { getFxRate } = await import('./yahoo')
  const rate = await getFxRate(from, to)
  return rate == null ? amount : amount * rate
}

export type PortfolioCorrelationExclusionReason = 'ticker_not_found' | 'insufficient_price_history'

export interface PortfolioCorrelationInput {
  symbol: string
  name: string
  market_value?: number
}

export interface PortfolioCorrelationAsset {
  symbol: string
  name: string
  observations: number
  weight: number
  expected_return_annual: number
  volatility_annual: number
}

export interface PortfolioCorrelationExclusion {
  symbol: string
  reason: PortfolioCorrelationExclusionReason
}

export interface PortfolioCorrelationResult {
  analysis_basis: 'modern_portfolio_theory'
  generated_at: string
  lookback_days: number
  min_returns: number
  risk_free_rate: number
  symbols: string[]
  assets: PortfolioCorrelationAsset[]
  matrix: (number | null)[][]
  covariance_matrix: (number | null)[][]
  current_portfolio: PortfolioMptPoint | null
  min_variance_portfolio: PortfolioMptPoint | null
  max_sharpe_portfolio: PortfolioMptPoint | null
  efficient_frontier: PortfolioMptPoint[]
  simulations: PortfolioMptPoint[]
  excluded: PortfolioCorrelationExclusion[]
}

export interface PortfolioCorrelationOptions {
  generatedAt?: string
  lookbackDays: number
  minReturns: number
  riskFreeRate?: number
  simulations?: number
}

export interface PortfolioMptPoint {
  label: string
  expected_return_annual: number
  volatility_annual: number
  sharpe_ratio: number | null
  weights: Record<string, number>
}

interface ReturnSeries {
  symbol: string
  name: string
  returnsByDate: Map<string, number>
}

function normalizeTicker(symbol: string): string {
  const raw = symbol.trim().toUpperCase()
  const m = raw.match(/^([A-Z]{2})\.(.+)$/)
  if (!m) return raw
  const market = m[1]
  const code = m[2] ?? ''
  if (market === 'US') return code
  if (market === 'HK') return `${code.replace(/^0+/, '').padStart(4, '0')}.HK`
  if (market === 'SH') return `${code}.SS`
  if (market === 'SZ') return `${code}.SZ`
  return raw
}

export function collectPortfolioCorrelationInputs(portfolio: FullPortfolio): PortfolioCorrelationInput[] {
  const bySymbol = new Map<string, PortfolioCorrelationInput>()

  for (const position of portfolio.positions ?? []) {
    const symbol = normalizeTicker(position.symbol)
    if (!symbol || bySymbol.has(symbol)) continue
    bySymbol.set(symbol, { symbol, name: position.name || symbol })
  }

  for (const position of [...(portfolio.moomoo_live ?? []), ...(portfolio.moomoo_paper ?? [])]) {
    const symbol = normalizeTicker(position.symbol)
    if (!symbol || bySymbol.has(symbol)) continue
    bySymbol.set(symbol, { symbol, name: symbol })
  }

  return [...bySymbol.values()]
}

export async function collectPortfolioMptInputs(
  portfolio: FullPortfolio,
  convert: FxConverter = defaultFxConverter,
): Promise<PortfolioCorrelationInput[]> {
  const bySymbol = new Map<string, PortfolioCorrelationInput>()
  const ghostfolioPositions = portfolio.positions ?? []

  // Ghostfolio market values are all denominated in the base currency
  // (valueInBaseCurrency), so they are already directly comparable — no FX.
  if (ghostfolioPositions.length > 0) {
    for (const position of ghostfolioPositions) {
      const symbol = normalizeTicker(position.symbol)
      if (!symbol) continue
      const existing = bySymbol.get(symbol)
      const marketValue = Number.isFinite(position.market_value) ? Math.max(0, position.market_value) : 0
      bySymbol.set(symbol, {
        symbol,
        name: existing?.name ?? position.name ?? symbol,
        market_value: (existing?.market_value ?? 0) + marketValue,
      })
    }
    return [...bySymbol.values()]
  }

  // Moomoo-only fallback: positions can be in different market currencies
  // (USD for US tickers, HKD for HK tickers). Convert every value to a single
  // base currency before summing so portfolio weights aren't distorted by
  // adding raw HKD to raw USD.
  const base = portfolio.net_worth_currency || 'USD'
  for (const position of [...(portfolio.moomoo_live ?? []), ...(portfolio.moomoo_paper ?? [])]) {
    const symbol = normalizeTicker(position.symbol)
    if (!symbol) continue
    const existing = bySymbol.get(symbol)
    const rawValue = Number.isFinite(position.market_value) ? Math.max(0, position.market_value) : 0
    const positionCurrency = position.currency ?? base
    const marketValue = await convert(rawValue, positionCurrency, base)
    bySymbol.set(symbol, {
      symbol,
      name: existing?.name ?? symbol,
      market_value: (existing?.market_value ?? 0) + marketValue,
    })
  }

  return [...bySymbol.values()]
}

function buildReturnSeries(input: PortfolioCorrelationInput, bars: DailyBar[]): ReturnSeries | null {
  const sorted = [...bars]
    .filter(bar => Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => a.time.localeCompare(b.time))

  const returnsByDate = new Map<string, number>()
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (!prev || !cur || prev.close <= 0) continue
    const dailyReturn = (cur.close - prev.close) / prev.close
    if (Number.isFinite(dailyReturn)) returnsByDate.set(cur.time, dailyReturn)
  }

  if (returnsByDate.size === 0) return null
  return { symbol: input.symbol, name: input.name, returnsByDate }
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n !== ys.length || n < 2) return null

  const meanX = xs.reduce((sum, x) => sum + x, 0) / n
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n
  let covariance = 0
  let varianceX = 0
  let varianceY = 0

  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX
    const dy = ys[i]! - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }

  const denom = Math.sqrt(varianceX * varianceY)
  if (denom === 0) return null
  return Math.max(-1, Math.min(1, covariance / denom))
}

function covariance(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n !== ys.length || n < 2) return null

  const meanX = xs.reduce((sum, x) => sum + x, 0) / n
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n
  let out = 0
  for (let i = 0; i < n; i++) {
    out += (xs[i]! - meanX) * (ys[i]! - meanY)
  }
  return out / (n - 1)
}

function mean(values: Iterable<number>): number {
  let sum = 0
  let count = 0
  for (const value of values) {
    sum += value
    count += 1
  }
  return count === 0 ? 0 : sum / count
}

function variance(values: Iterable<number>): number | null {
  const arr = [...values]
  if (arr.length < 2) return null
  const m = mean(arr)
  const sumSq = arr.reduce((sum, value) => sum + (value - m) ** 2, 0)
  return sumSq / (arr.length - 1)
}

function pairwiseCorrelation(a: ReturnSeries, b: ReturnSeries, minReturns: number): number | null {
  if (a.symbol === b.symbol) return 1
  const xs: number[] = []
  const ys: number[] = []

  for (const [date, aReturn] of a.returnsByDate) {
    const bReturn = b.returnsByDate.get(date)
    if (bReturn === undefined) continue
    xs.push(aReturn)
    ys.push(bReturn)
  }

  if (xs.length < minReturns) return null
  return pearson(xs, ys)
}

function pairwiseCovariance(a: ReturnSeries, b: ReturnSeries, minReturns: number): number | null {
  if (a.symbol === b.symbol) {
    const v = variance(a.returnsByDate.values())
    return v == null ? null : v * 252
  }
  const xs: number[] = []
  const ys: number[] = []

  for (const [date, aReturn] of a.returnsByDate) {
    const bReturn = b.returnsByDate.get(date)
    if (bReturn === undefined) continue
    xs.push(aReturn)
    ys.push(bReturn)
  }

  if (xs.length < minReturns) return null
  const cov = covariance(xs, ys)
  return cov == null ? null : cov * 252
}

function normalizedCurrentWeights(inputs: PortfolioCorrelationInput[], includedSymbols: string[]): number[] {
  const bySymbol = new Map(inputs.map(input => [input.symbol, input.market_value ?? 0]))
  const raw = includedSymbols.map(symbol => Math.max(0, bySymbol.get(symbol) ?? 0))
  const total = raw.reduce((sum, value) => sum + value, 0)
  if (total > 0) return raw.map(value => value / total)
  return includedSymbols.map(() => includedSymbols.length > 0 ? 1 / includedSymbols.length : 0)
}

function weightsRecord(symbols: string[], weights: number[]): Record<string, number> {
  const out: Record<string, number> = {}
  symbols.forEach((symbol, i) => {
    out[symbol] = weights[i] ?? 0
  })
  return out
}

function mptPoint(
  label: string,
  weights: number[],
  symbols: string[],
  expectedReturns: number[],
  covarianceMatrix: (number | null)[][],
  riskFreeRate: number,
): PortfolioMptPoint {
  const expected_return_annual = weights.reduce((sum, weight, i) => sum + weight * (expectedReturns[i] ?? 0), 0)
  let portfolioVariance = 0
  for (let i = 0; i < weights.length; i++) {
    for (let j = 0; j < weights.length; j++) {
      portfolioVariance += (weights[i] ?? 0) * (weights[j] ?? 0) * (covarianceMatrix[i]?.[j] ?? 0)
    }
  }
  const volatility_annual = Math.sqrt(Math.max(0, portfolioVariance))
  const sharpe_ratio = volatility_annual > 0 ? (expected_return_annual - riskFreeRate) / volatility_annual : null
  return {
    label,
    expected_return_annual,
    volatility_annual,
    sharpe_ratio,
    weights: weightsRecord(symbols, weights),
  }
}

function hashSeed(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function seededRandom(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function randomLongOnlyWeights(count: number, random: () => number): number[] {
  const raw = Array.from({ length: count }, () => -Math.log(Math.max(random(), 1e-12)))
  const total = raw.reduce((sum, value) => sum + value, 0)
  return raw.map(value => value / total)
}

function buildSimulations(
  symbols: string[],
  currentWeights: number[],
  expectedReturns: number[],
  covarianceMatrix: (number | null)[][],
  options: Required<Pick<PortfolioCorrelationOptions, 'riskFreeRate' | 'simulations'>>,
): PortfolioMptPoint[] {
  if (symbols.length === 0) return []
  const points: PortfolioMptPoint[] = [
    mptPoint('current', currentWeights, symbols, expectedReturns, covarianceMatrix, options.riskFreeRate),
    mptPoint('equal weight', symbols.map(() => 1 / symbols.length), symbols, expectedReturns, covarianceMatrix, options.riskFreeRate),
  ]

  symbols.forEach((symbol, i) => {
    points.push(mptPoint(symbol, symbols.map((_, j) => (i === j ? 1 : 0)), symbols, expectedReturns, covarianceMatrix, options.riskFreeRate))
  })

  const random = seededRandom(hashSeed(symbols.join('|')))
  for (let i = 0; i < options.simulations; i++) {
    points.push(mptPoint('sample', randomLongOnlyWeights(symbols.length, random), symbols, expectedReturns, covarianceMatrix, options.riskFreeRate))
  }

  return points
}

function efficientFrontier(points: PortfolioMptPoint[]): PortfolioMptPoint[] {
  const sorted = [...points]
    .filter(point => Number.isFinite(point.volatility_annual) && Number.isFinite(point.expected_return_annual))
    .sort((a, b) => a.volatility_annual - b.volatility_annual || a.expected_return_annual - b.expected_return_annual)

  const frontier: PortfolioMptPoint[] = []
  let bestReturn = -Infinity
  for (const point of sorted) {
    if (point.expected_return_annual > bestReturn + 0.000001) {
      frontier.push({ ...point, label: 'frontier' })
      bestReturn = point.expected_return_annual
    }
  }
  return frontier
}

export function buildPortfolioCorrelation(
  inputs: PortfolioCorrelationInput[],
  barsBySymbol: Map<string, DailyBar[]>,
  options: PortfolioCorrelationOptions,
): PortfolioCorrelationResult {
  const minReturns = Math.max(2, options.minReturns)
  const riskFreeRate = options.riskFreeRate ?? 0
  const simulationCount = options.simulations ?? 300
  const series: ReturnSeries[] = []
  const excluded: PortfolioCorrelationExclusion[] = []

  for (const input of inputs) {
    const bars = barsBySymbol.get(input.symbol) ?? []
    const returns = buildReturnSeries(input, bars)
    if (!returns) {
      excluded.push({ symbol: input.symbol, reason: bars.length === 0 ? 'ticker_not_found' : 'insufficient_price_history' })
      continue
    }
    if (returns.returnsByDate.size < minReturns) {
      excluded.push({ symbol: input.symbol, reason: 'insufficient_price_history' })
      continue
    }
    series.push(returns)
  }

  const matrix = series.map(row =>
    series.map(col => pairwiseCorrelation(row, col, minReturns)),
  )
  const covariance_matrix = series.map(row =>
    series.map(col => pairwiseCovariance(row, col, minReturns)),
  )
  const symbols = series.map(s => s.symbol)
  const expectedReturns = series.map(s => mean(s.returnsByDate.values()) * 252)
  const weights = normalizedCurrentWeights(inputs, symbols)
  const simulations = buildSimulations(
    symbols,
    weights,
    expectedReturns,
    covariance_matrix,
    { riskFreeRate, simulations: simulationCount },
  )
  const current_portfolio = simulations.find(point => point.label === 'current') ?? null
  const min_variance_portfolio = simulations.reduce<PortfolioMptPoint | null>(
    (best, point) => (!best || point.volatility_annual < best.volatility_annual ? point : best),
    null,
  )
  const max_sharpe_portfolio = simulations.reduce<PortfolioMptPoint | null>((best, point) => {
    if (point.sharpe_ratio == null) return best
    return !best || best.sharpe_ratio == null || point.sharpe_ratio > best.sharpe_ratio ? point : best
  }, null)

  return {
    analysis_basis: 'modern_portfolio_theory',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    lookback_days: options.lookbackDays,
    min_returns: minReturns,
    risk_free_rate: riskFreeRate,
    symbols,
    assets: series.map((s, i) => ({
      symbol: s.symbol,
      name: s.name,
      observations: s.returnsByDate.size,
      weight: weights[i] ?? 0,
      expected_return_annual: expectedReturns[i] ?? 0,
      volatility_annual: Math.sqrt(covariance_matrix[i]?.[i] ?? 0),
    })),
    matrix,
    covariance_matrix,
    current_portfolio,
    min_variance_portfolio,
    max_sharpe_portfolio,
    efficient_frontier: efficientFrontier(simulations),
    simulations,
    excluded,
  }
}
