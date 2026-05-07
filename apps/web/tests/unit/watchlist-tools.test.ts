import { describe, expect, it } from 'vitest'
import { makeWatchlistTools } from '../../server/mastra/tools/watchlist'

const fakeClient = {
  async listWatchlist({ group }: { group?: string }) {
    return [{ code: 'US.NVDA', name: 'NVIDIA', group: group ?? 'All' }]
  },
  async addWatchlistItem(_args: { code: string }) {
    return { status: 'ok' }
  },
  async removeWatchlistItem(_args: { code: string }) {
    return { status: 'ok' }
  },
}

describe('watchlist tools', () => {
  it('list returns items', async () => {
    const t = makeWatchlistTools(fakeClient as any)
    const out = await t.list.execute({ group: 'All' } as any)
    expect(out[0].code).toBe('US.NVDA')
  })
  it('add returns ok', async () => {
    const t = makeWatchlistTools(fakeClient as any)
    const out = await t.add.execute({ code: 'US.AAPL', group: 'All' } as any)
    expect(out.status).toBe('ok')
  })
  it('remove returns ok', async () => {
    const t = makeWatchlistTools(fakeClient as any)
    const out = await t.remove.execute({ code: 'US.AAPL', group: 'All' } as any)
    expect(out.status).toBe('ok')
  })
})
