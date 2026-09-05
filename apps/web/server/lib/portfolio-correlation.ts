import {
  buildPortfolioCorrelation,
  collectPortfolioMptInputs,
  type PortfolioCorrelationResult,
} from './portfolio-correlation-core'
import { getFullPortfolioCached } from './portfolio-cache'
import { getDailyBars } from './yahoo'

const LOOKBACK_DAYS = 252
const MIN_RETURNS = 20

function getRiskFreeRate(): number {
  const rate = Number(process.env.PORTFOLIO_RISK_FREE_RATE ?? 0)
  return Number.isFinite(rate) ? rate : 0
}

async function getPortfolioCorrelation(opts?: { force?: boolean }): Promise<PortfolioCorrelationResult> {
  const portfolio = await getFullPortfolioCached({ force: Boolean(opts?.force) })
  const inputs = await collectPortfolioMptInputs(portfolio)
  const barsBySymbol = new Map(
    await Promise.all(
      inputs.map(async input => [input.symbol, await getDailyBars(input.symbol, LOOKBACK_DAYS + 1)] as const),
    ),
  )

  return buildPortfolioCorrelation(inputs, barsBySymbol, {
    lookbackDays: LOOKBACK_DAYS,
    minReturns: MIN_RETURNS,
    riskFreeRate: getRiskFreeRate(),
  })
}

const cached = defineCachedFunction(
  async (opts?: { force?: boolean }): Promise<PortfolioCorrelationResult> => getPortfolioCorrelation(opts),
  {
    name: 'portfolio',
    group: 'correlation',
    getKey: () => 'full',
    maxAge: 60,
    staleMaxAge: 60 * 10,
    swr: true,
  },
) as (opts?: { force?: boolean }) => Promise<PortfolioCorrelationResult>

const CORRELATION_CACHE_KEY = 'cache:portfolio:correlation:full.json'

/** See portfolio-cache.ts: a forced call drops the entry rather than serving it stale under swr. */
export async function getPortfolioCorrelationCached(opts?: { force?: boolean }): Promise<PortfolioCorrelationResult> {
  if (opts?.force) await useStorage().removeItem(CORRELATION_CACHE_KEY)
  return cached(opts)
}
