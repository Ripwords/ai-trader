import { getFullPortfolio, type FullPortfolio } from '../lib/holdings'

// SWR cache: serve fresh for 60s, then serve stale up to 10min while a
// background revalidation runs. The page's refresh button passes ?force=1
// to bypass the cache for hard refreshes.
export default defineCachedEventHandler(
  async (): Promise<FullPortfolio> => getFullPortfolio(),
  {
    name: 'portfolio',
    getKey: () => 'full',
    maxAge: 60,
    staleMaxAge: 60 * 10,
    swr: true,
    shouldBypassCache: (event) => Boolean(getQuery(event).force),
  },
)
