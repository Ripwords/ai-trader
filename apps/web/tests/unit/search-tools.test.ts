import { describe, expect, it, vi } from 'vitest'
import { makeSearchTools } from '../../server/mastra/tools/search'

vi.mock('ofetch', () => ({
  ofetch: vi.fn(async () => ({
    results: [
      { title: 'Test', url: 'https://x.com', content: '...', published_date: '2026-05-08' },
    ],
  })),
}))

describe('search tools', () => {
  it('web search returns results', async () => {
    const t = makeSearchTools('fake-key')
    const out = await t.webSearch.execute({ query: 'NVDA earnings', maxResults: 3 } as any)
    expect(out.results.length).toBe(1)
  })

  it('news search throws without key', async () => {
    const t = makeSearchTools('')
    await expect(t.newsSearch.execute({ query: 'x', maxResults: 3 } as any)).rejects.toThrow()
  })
})
