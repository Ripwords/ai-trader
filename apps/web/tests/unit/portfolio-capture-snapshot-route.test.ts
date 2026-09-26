import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const capturePortfolioSnapshot = vi.fn()
const captureInvestmentSnapshot = vi.fn()

vi.mock('../../server/lib/portfolio-history', () => ({
  capturePortfolioSnapshot: (...args: unknown[]) => capturePortfolioSnapshot(...args),
}))
vi.mock('../../server/lib/investment-history', () => ({
  captureInvestmentSnapshot: (...args: unknown[]) => captureInvestmentSnapshot(...args),
  withDeadline: <T>(p: Promise<T>) => p,
}))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return {
    ...actual,
    readBody: (e: { _body: unknown }) => Promise.resolve(e._body),
  }
})

type Handler = (event: H3Event) => Promise<{ source: string, skipped: boolean }>
let handler: Handler

beforeEach(async () => {
  vi.resetModules()
  capturePortfolioSnapshot.mockReset()
  captureInvestmentSnapshot.mockReset()
  capturePortfolioSnapshot.mockImplementation(async (source: string) => ({
    id: 'nw', capturedAt: '2026-09-26T00:00:00.000Z', source, skipped: false, totals: null,
  }))
  captureInvestmentSnapshot.mockImplementation(async (source: string) => ({
    id: 'inv', capturedAt: '2026-09-26T00:00:00.000Z', source, skipped: false, row: null,
  }))
  const mod = await import('../../server/api/portfolio/capture-snapshot.post')
  handler = mod.default as unknown as Handler
})

function makeEvent(body: unknown): H3Event {
  return { node: { req: { method: 'POST', headers: {} } }, context: {}, _body: body } as unknown as H3Event
}

describe('POST /api/portfolio/capture-snapshot', () => {
  it('records a manual snapshot of both layers when no source is given', async () => {
    const result = await handler(makeEvent(undefined))
    expect(capturePortfolioSnapshot).toHaveBeenCalledWith('manual')
    expect(captureInvestmentSnapshot).toHaveBeenCalledWith('manual')
    expect(result.source).toBe('manual')
  })

  it('takes the idempotent daily auto snapshot when source is auto', async () => {
    await handler(makeEvent({ source: 'auto' }))
    expect(capturePortfolioSnapshot).toHaveBeenCalledWith('auto')
    expect(captureInvestmentSnapshot).toHaveBeenCalledWith('auto')
  })

  it('treats an unknown source as manual', async () => {
    await handler(makeEvent({ source: 'bogus' }))
    expect(capturePortfolioSnapshot).toHaveBeenCalledWith('manual')
  })
})
