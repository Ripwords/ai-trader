import type {
  PortfolioCorrelationAsset,
  PortfolioCorrelationExclusion,
  PortfolioCorrelationResult,
  PortfolioMptPoint,
} from './portfolio-correlation-core'

export type PortfolioMptAnalysisView = 'summary' | 'frontier' | 'heatmap' | 'full'
export type PortfolioMptSubsetMode = 'top_weight' | 'requested' | 'lowest_correlation' | 'highest_correlation' | 'all'

export interface PortfolioMptAnalysisRequest {
  view?: PortfolioMptAnalysisView
  symbols?: string[]
  maxSymbols?: number
  subset?: PortfolioMptSubsetMode
  sampleLimit?: number
}

export interface PortfolioMptHeatmapAsset {
  symbol: string
  name: string
  weight: number
  expected_return_annual: number
  volatility_annual: number
}

export interface PortfolioMptHeatmap {
  subset_reason: string
  assets: PortfolioMptHeatmapAsset[]
  matrix: (number | null)[][]
}

export interface PortfolioMptAnalysisOutput {
  view: PortfolioMptAnalysisView
  generated_at: string
  lookback_days: number
  risk_free_rate: number
  valid_tickers: number
  selected_symbols: string[]
  missing_requested_symbols: string[]
  summary: {
    current: PortfolioMptPoint | null
    min_variance: PortfolioMptPoint | null
    max_sharpe: PortfolioMptPoint | null
    sharpe_gap: number | null
    sharpe_status: string
  }
  heatmap?: PortfolioMptHeatmap
  frontier?: {
    points: PortfolioMptPoint[]
    sample_points: PortfolioMptPoint[]
  }
  assets?: PortfolioCorrelationAsset[]
  excluded: PortfolioCorrelationExclusion[]
  notes: string[]
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase()
}

function sharpeStatus(gap: number | null): string {
  if (gap == null) return 'insufficient ratio data'
  if (gap <= 0.05) return 'near sampled max'
  if (gap <= 0.25) return 'moderate gap'
  return 'large gap'
}

function averageCorrelation(asset: PortfolioCorrelationAsset, result: PortfolioCorrelationResult, absolute = false): number {
  const i = result.symbols.indexOf(asset.symbol)
  if (i < 0) return 0
  const values = (result.matrix[i] ?? [])
    .filter((value, j) => j !== i && value != null && Number.isFinite(value)) as number[]
  if (values.length === 0) return 0
  const sum = values.reduce((total, value) => total + (absolute ? Math.abs(value) : value), 0)
  return sum / values.length
}

function selectAssets(result: PortfolioCorrelationResult, request: Required<Pick<PortfolioMptAnalysisRequest, 'maxSymbols'>> & PortfolioMptAnalysisRequest): {
  assets: PortfolioCorrelationAsset[]
  reason: string
  missingRequested: string[]
} {
  const bySymbol = new Map(result.assets.map(asset => [asset.symbol, asset]))
  const requested = (request.symbols ?? []).map(normalizeSymbol).filter(Boolean)
  const limit = request.subset === 'all' ? result.assets.length : request.maxSymbols

  if (requested.length > 0) {
    const assets = requested
      .map(symbol => bySymbol.get(symbol))
      .filter((asset): asset is PortfolioCorrelationAsset => Boolean(asset))
      .slice(0, limit)
    return {
      assets,
      reason: 'requested symbols',
      missingRequested: requested.filter(symbol => !bySymbol.has(symbol)),
    }
  }

  const subset = request.subset ?? 'top_weight'
  if (subset === 'all') {
    return { assets: result.assets, reason: 'all valid tickers', missingRequested: [] }
  }
  if (subset === 'lowest_correlation') {
    return {
      assets: [...result.assets].sort((a, b) => averageCorrelation(a, result) - averageCorrelation(b, result)).slice(0, limit),
      reason: 'lowest average correlation',
      missingRequested: [],
    }
  }
  if (subset === 'highest_correlation') {
    return {
      assets: [...result.assets].sort((a, b) => averageCorrelation(b, result, true) - averageCorrelation(a, result, true)).slice(0, limit),
      reason: 'highest average absolute correlation',
      missingRequested: [],
    }
  }
  return {
    assets: [...result.assets].sort((a, b) => b.weight - a.weight).slice(0, limit),
    reason: 'top current weights',
    missingRequested: [],
  }
}

function heatmapFor(result: PortfolioCorrelationResult, assets: PortfolioCorrelationAsset[], reason: string): PortfolioMptHeatmap {
  const indices = assets.map(asset => result.symbols.indexOf(asset.symbol))
  return {
    subset_reason: reason,
    assets: assets.map(asset => ({
      symbol: asset.symbol,
      name: asset.name,
      weight: asset.weight,
      expected_return_annual: asset.expected_return_annual,
      volatility_annual: asset.volatility_annual,
    })),
    matrix: indices.map(row => indices.map(col => (row >= 0 && col >= 0 ? result.matrix[row]?.[col] ?? null : null))),
  }
}

export function projectPortfolioMptAnalysis(
  result: PortfolioCorrelationResult,
  request: PortfolioMptAnalysisRequest = {},
): PortfolioMptAnalysisOutput {
  const view = request.view ?? 'summary'
  const maxSymbols = clampInt(request.maxSymbols, view === 'full' ? 16 : 10, 2, 24)
  const sampleLimit = clampInt(request.sampleLimit, 80, 0, 160)
  const selected = selectAssets(result, { ...request, maxSymbols })

  const currentSharpe = result.current_portfolio?.sharpe_ratio
  const maxSharpe = result.max_sharpe_portfolio?.sharpe_ratio
  const sharpe_gap =
    currentSharpe == null || maxSharpe == null || !Number.isFinite(currentSharpe) || !Number.isFinite(maxSharpe)
      ? null
      : maxSharpe - currentSharpe

  const out: PortfolioMptAnalysisOutput = {
    view,
    generated_at: result.generated_at,
    lookback_days: result.lookback_days,
    risk_free_rate: result.risk_free_rate,
    valid_tickers: result.assets.length,
    selected_symbols: selected.assets.map(asset => asset.symbol),
    missing_requested_symbols: selected.missingRequested,
    summary: {
      current: result.current_portfolio,
      min_variance: result.min_variance_portfolio,
      max_sharpe: result.max_sharpe_portfolio,
      sharpe_gap,
      sharpe_status: sharpeStatus(sharpe_gap),
    },
    excluded: result.excluded,
    notes: [
      'MPT metrics are based on historical daily returns for valid tickers only.',
      'Heatmap subsets do not recompute the frontier; they only reduce the displayed correlation matrix.',
    ],
  }

  if (view !== 'frontier') {
    out.heatmap = heatmapFor(result, selected.assets, selected.reason)
  }
  if (view === 'frontier' || view === 'full') {
    out.frontier = {
      points: result.efficient_frontier,
      sample_points: result.simulations.slice(0, sampleLimit),
    }
    out.heatmap = heatmapFor(result, selected.assets, selected.reason)
  }
  if (view === 'full') {
    out.assets = result.assets
  }

  return out
}
