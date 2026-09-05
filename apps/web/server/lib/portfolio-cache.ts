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
 * ?force=1) to drop the entry and recompute.
 *
 * Lives in its own module rather than holdings.ts because defineCachedFunction
 * is a Nitro-runtime auto-import; holdings.ts is imported directly by unit
 * tests, which run without the Nitro runtime. The history writer
 * (portfolio-history.ts) deliberately keeps calling the raw getFullPortfolio()
 * so recorded snapshots are never stale.
 */
const cached = defineCachedFunction(
  async (): Promise<FullPortfolio> => getFullPortfolio(),
  {
    name: 'portfolio',
    group: 'full',
    getKey: () => 'full',
    maxAge: 60,
    staleMaxAge: 60 * 10,
    swr: true,
  },
) as () => Promise<FullPortfolio>

/** Nitro's key for the entry above: base "/cache", group, name, key + ".json". */
export const FULL_PORTFOLIO_CACHE_KEY = 'cache:portfolio:full:full.json'

/**
 * Stale-while-revalidate keeps page loads instant, but under swr an
 * invalidated call is answered with the stale entry while the refresh runs
 * in the background, so the refresh button returned the numbers it was asked
 * to replace. A forced call therefore removes the entry first, which makes
 * the next read wait for a fresh fetch.
 */
export async function getFullPortfolioCached(opts?: { force?: boolean }): Promise<FullPortfolio> {
  if (opts?.force) await useStorage().removeItem(FULL_PORTFOLIO_CACHE_KEY)
  return cached()
}

/**
 * The cached portfolio if any run has ever filled it, stale or not, without
 * waiting on the cross-broker fetch. A cold cache starts the fetch in the
 * background so the next caller finds it. For surfaces that decorate rather
 * than depend on the numbers (the chat landing page's prompts).
 */
export async function peekFullPortfolio(): Promise<FullPortfolio | null> {
  const entry = await useStorage().getItem<{ value?: FullPortfolio }>(FULL_PORTFOLIO_CACHE_KEY)
  if (entry?.value) return entry.value
  void cached().catch(() => undefined)
  return null
}
