import { beforeEach, describe, expect, it, vi } from 'vitest'

const getFullPortfolio = vi.fn()
vi.mock('../../server/lib/holdings', () => ({ getFullPortfolio: () => getFullPortfolio() }))

let store: Map<string, unknown>
const removeItem = vi.fn(async (k: string) => { store.delete(k) })

beforeEach(() => {
  vi.resetModules()
  store = new Map()
  removeItem.mockClear()
  getFullPortfolio.mockReset().mockResolvedValue({ status: 'ok', positions: [] })
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
  vi.stubGlobal('useStorage', () => ({
    getItem: async (k: string) => store.get(k) ?? null,
    removeItem,
  }))
})

// Nitro stores a cached function's entry under base:group:name:key.json; the
// Redis key on a running stack is ai-trader:cache:full:portfolio:full.json.
describe('portfolio cache keys', () => {
  it('peeks the entry Nitro actually wrote', async () => {
    store.set('cache:full:portfolio:full.json', { value: { status: 'ok', positions: [{ symbol: 'NVDA' }] } })
    const { peekFullPortfolio } = await import('../../server/lib/portfolio-cache')
    expect(await peekFullPortfolio()).toEqual({ status: 'ok', positions: [{ symbol: 'NVDA' }] })
  })

  it('removes that entry on a forced read', async () => {
    const { getFullPortfolioCached } = await import('../../server/lib/portfolio-cache')
    await getFullPortfolioCached({ force: true })
    expect(removeItem).toHaveBeenCalledWith('cache:full:portfolio:full.json')
  })

  it('removes the correlation entry on a forced read', async () => {
    vi.doMock('../../server/lib/portfolio-cache', () => ({ getFullPortfolioCached: async () => ({ positions: [] }) }))
    vi.doMock('../../server/lib/yahoo', () => ({ getDailyBars: async () => [] }))
    const { getPortfolioCorrelationCached } = await import('../../server/lib/portfolio-correlation')
    await getPortfolioCorrelationCached({ force: true })
    expect(removeItem).toHaveBeenCalledWith('cache:correlation:portfolio:full.json')
  })
})
