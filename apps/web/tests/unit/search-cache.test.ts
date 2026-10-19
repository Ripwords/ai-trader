import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroCache } from '../fixtures/nitro-cache'

const ofetch = vi.fn()
vi.mock('ofetch', () => ({ ofetch: (...args: unknown[]) => ofetch(...args) }))

let searchWithFallback: typeof import('../../server/lib/search')['searchWithFallback']

beforeEach(async () => {
  vi.resetModules()
  ofetch.mockReset()
  vi.stubEnv('SEARCH_PROVIDER', 'brave')
  vi.stubEnv('BRAVE_API_KEY', 'k')
  vi.stubEnv('TAVILY_API_KEY', '')
  stubNitroCache()
  ;({ searchWithFallback } = await import('../../server/lib/search'))
})

const braveNews = (title: string) => ({ results: [{ title, url: `https://x/${title}`, description: 'd' }] })

describe('searchWithFallback caching', () => {
  it('answers a repeat query from cache without calling the provider again', async () => {
    ofetch.mockResolvedValue(braveNews('a'))
    const first = await searchWithFallback('news', 'NVDA earnings', 5)
    const second = await searchWithFallback('news', 'NVDA earnings', 5)
    expect(second).toEqual(first)
    expect(ofetch).toHaveBeenCalledTimes(1)
  })

  it('keys on kind, query and size', async () => {
    ofetch.mockResolvedValue(braveNews('a'))
    await searchWithFallback('news', 'NVDA earnings', 5)
    await searchWithFallback('web', 'NVDA earnings', 5)
    await searchWithFallback('news', 'NVDA earnings', 8)
    await searchWithFallback('news', 'AMD earnings', 5)
    expect(ofetch).toHaveBeenCalledTimes(4)
  })

  it('does not cache an empty answer or a provider error', async () => {
    ofetch.mockResolvedValueOnce({ results: [] })
    ofetch.mockRejectedValueOnce(new Error('brave 503'))
    ofetch.mockResolvedValue(braveNews('b'))

    expect(await searchWithFallback('news', 'q', 5)).toEqual([])
    await expect(searchWithFallback('news', 'q', 5)).rejects.toThrow('brave 503')
    expect(await searchWithFallback('news', 'q', 5)).toHaveLength(1)
    expect(ofetch).toHaveBeenCalledTimes(3)
  })
})
