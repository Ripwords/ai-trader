import { getFullPortfolio, type FullPortfolio } from './holdings'

/**
 * Shared, request-coalescing cache for the cross-broker portfolio fetch.
 *
 * `getFullPortfolio()` makes 3 sequential Ghostfolio MCP round-trips plus a
 * moomoo getPortfolio per account, so it dominates the /portfolio page load.
 * The page hits /api/portfolio and /api/planning in parallel and both need
 * this exact data — without a shared cache a cold load runs the whole fetch
 * twice concurrently. defineCachedFunction also coalesces concurrent callers
 * onto a single in-flight promise, so the common (non-forced) load does the
 * heavy work once.
 *
 * Pass `{ force: true }` (wired to the page's hard-refresh button via
 * ?force=1) to invalidate and recompute. No stale-while-revalidate: with swr
 * on, Nitro answers an invalidated call with the old entry and refreshes in
 * the background, so the refresh button returned the numbers it was asked
 * to replace. An expired entry now waits for the fresh fetch instead.
 *
 * Lives in its own module rather than holdings.ts because defineCachedFunction
 * is a Nitro-runtime auto-import; holdings.ts is imported directly by unit
 * tests, which run without the Nitro runtime. The history writer
 * (portfolio-history.ts) deliberately keeps calling the raw getFullPortfolio()
 * so recorded snapshots are never stale.
 */
export const getFullPortfolioCached = defineCachedFunction(
  async (_opts?: { force?: boolean }): Promise<FullPortfolio> => getFullPortfolio(),
  {
    name: 'portfolio',
    group: 'full',
    getKey: () => 'full',
    maxAge: 60,
    swr: false,
    shouldInvalidateCache: (opts?: { force?: boolean }) => Boolean(opts?.force),
  },
) as (opts?: { force?: boolean }) => Promise<FullPortfolio>
