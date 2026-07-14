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

export const getPortfolioCorrelationCached = defineCachedFunction(
  async (opts?: { force?: boolean }): Promise<PortfolioCorrelationResult> => getPortfolioCorrelation(opts),
  {
    name: 'portfolio',
    group: 'correlation',
    getKey: () => 'full',
    maxAge: 60,
    staleMaxAge: 60 * 10,
    swr: true,
    shouldInvalidateCache: (opts?: { force?: boolean }) => Boolean(opts?.force),
  },
) as (opts?: { force?: boolean }) => Promise<PortfolioCorrelationResult>
