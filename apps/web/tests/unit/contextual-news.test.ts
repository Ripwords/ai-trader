import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchMock = vi.fn()
vi.mock('../../server/lib/search', () => ({ searchWithFallback: searchMock }))

// Stub the LLM layer so Task 1 only exercises ticker + macro.
const deriveMock = vi.fn()
vi.mock('../../server/lib/contextual-news-angles', () => ({ deriveAngles: deriveMock }))

let getContextualNews: typeof import('../../server/lib/contextual-news')['getContextualNews']

beforeEach(async () => {
  vi.resetModules()
  searchMock.mockReset()
  deriveMock.mockReset()
  deriveMock.mockResolvedValue([]) // no contextual queries in this task
  ;({ getContextualNews } = await import('../../server/lib/contextual-news'))
})

function news(title: string, url: string) {
  return { title, url, content: title }
}

describe('getContextualNews — ticker + macro', () => {
  it('returns ticker and macro groups from separate searches', async () => {
    searchMock.mockImplementation(async (_kind: string, q: string) => {
      if (q.includes('NVDA')) return [news('nvidia earnings', 'https://a/1')]
      return [news('fed holds rates', 'https://b/1')]
    })

    const res = await getContextualNews({ symbol: 'NVDA', companyName: 'NVIDIA Corp', maxResults: 5 })

    expect(res.ticker.map(r => r.url)).toEqual(['https://a/1'])
    expect(res.macro.length).toBeGreaterThan(0)
    expect(res.contextual).toEqual([])
  })

  it('dedupes across groups, ticker wins', async () => {
    searchMock.mockResolvedValue([news('shared', 'https://dup/1')])
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    const allUrls = [...res.ticker, ...res.macro, ...res.contextual].map(r => r.url)
    expect(allUrls.filter(u => u === 'https://dup/1')).toHaveLength(1)
    expect(res.ticker.map(r => r.url)).toContain('https://dup/1')
  })

  it('caps macro at 4', async () => {
    searchMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => news(`m${i}`, `https://m/${i}`)),
    )
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    expect(res.macro.length).toBeLessThanOrEqual(4)
  })

  it('survives a failing search group', async () => {
    searchMock.mockImplementation(async (_k: string, q: string) => {
      if (q.includes('NVDA')) return [news('ok', 'https://a/1')]
      throw new Error('macro provider down')
    })
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    expect(res.ticker).toHaveLength(1)
    expect(res.macro).toEqual([])
  })
})
