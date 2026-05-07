import { describe, expect, it, vi } from 'vitest'
import { makeMarketTools } from '../../server/mastra/tools/market'

const fakeClient = {
  async getKline(args: { code: string; ktype: string; num: number }) {
    return {
      code: args.code,
      ktype: args.ktype,
      bars: [
        {
          time: '2026-05-06T00:00:00',
          open: 100,
          high: 110,
          low: 95,
          close: 108,
          volume: 1000,
          turnover: 100000,
        },
      ],
    }
  },
  async getSnapshot(args: { code: string }) {
    return {
      code: args.code,
      name: 'Test',
      lastPrice: 125.5,
      openPrice: 120,
      highPrice: 126,
      lowPrice: 119.5,
      prevClosePrice: 121,
      changeRate: 0.0372,
      volume: 12345678,
      turnover: 1500000000,
      updateTime: '2026-05-07T16:00:00',
    }
  },
}

describe('market tools', () => {
  it('kline tool returns bars[]', async () => {
    const tools = makeMarketTools(fakeClient as any)
    const out = await tools.kline.execute({ code: 'US.NVDA', ktype: '1d', num: 1 } as any)
    expect(out.bars[0].close).toBe(108)
  })

  it('snapshot tool returns lastPrice', async () => {
    const tools = makeMarketTools(fakeClient as any)
    const out = await tools.snapshot.execute({ code: 'US.NVDA' } as any)
    expect(out.lastPrice).toBe(125.5)
  })

  it('kline tool propagates client errors', async () => {
    const erroring = { ...fakeClient, getKline: vi.fn().mockRejectedValue(new Error('boom')) }
    const tools = makeMarketTools(erroring as any)
    await expect(
      tools.kline.execute({ code: 'US.NVDA', ktype: '1d', num: 1 } as any),
    ).rejects.toThrow('boom')
  })
})
