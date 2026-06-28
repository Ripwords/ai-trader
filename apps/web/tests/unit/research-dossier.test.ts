import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: vi.fn(async (s: string) =>
    s === 'BAD' ? { status: 'not_found' } : { status: 'resolved', symbol: 'US.NVDA', name: 'NVIDIA' }),
  getFinancialMetrics: vi.fn(async () => ({ pe: 30 })),
  getHistorical: vi.fn(async () => [{ year: 2025, revenue: 1 }]),
  getQuarterlyHistory: vi.fn(async () => [{ q: '2025Q4', eps: 1 }]),
  getEarningsInfo: vi.fn(async () => ({ nextEarningsDate: '2026-08-01' })),
  getInsiderTrades: vi.fn(async () => [{ name: 'CEO', shares: 100 }]),
}))
vi.mock('../../server/lib/contextual-news', () => ({
  getContextualNews: vi.fn(async () => ({ ticker: [], macro: [], contextual: [] })),
}))
vi.mock('../../server/lib/agents/runs-query', () => ({
  getLatestRunForSymbol: vi.fn(async () => ({ runId: 'r1', rating: 'BUY', confidence: 72, finishedAt: '2026-06-27T00:00:00Z' })),
  getRunAssessment: vi.fn(async () => ({ runId: 'r1', rating: 'BUY', confidence: 72, rationale: 'strong', finishedAt: '2026-06-27T00:00:00Z' })),
}))
vi.mock('../../server/lib/search', () => ({ searchWithFallback: vi.fn(async () => ({ results: [{ title: 'bio' }] })) }))

let buildResearchDossier: typeof import('../../server/llm/research/dossier')['buildResearchDossier']
beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
    ({ ok: true, json: async () => ({ fair_value: 100, data_quality: 'full' }) }) as unknown as Response) as unknown as typeof fetch
  buildResearchDossier = (await import('../../server/llm/research/dossier')).buildResearchDossier
})

const baseOpts = { preset: 'research' as const, userId: 'u1', baseUrl: 'http://x', sessionCookie: 'session=abc' }

describe('buildResearchDossier', () => {
  it('returns an unresolved error for a bad symbol (no fabrication)', async () => {
    const d = await buildResearchDossier('BAD', baseOpts)
    expect(d).toMatchObject({ error: 'unresolved' })
  })
  it('aggregates all fast-profile sections and the latest agents verdict', async () => {
    const d = await buildResearchDossier('NVDA', baseOpts) as Awaited<ReturnType<typeof buildResearchDossier>> & { symbol: string }
    expect(d).toMatchObject({ symbol: 'US.NVDA', companyName: 'NVIDIA', preset: 'research' })
    const dossier = d as Extract<typeof d, { valuation: unknown }>
    expect(dossier.valuation.ok).toBe(true)
    expect(dossier.fundamentals.ok).toBe(true)
    expect(dossier.news.ok).toBe(true)
    expect(dossier.agentsVerdict.ok).toBe(true)
    expect(dossier.agentsVerdict.data?.rating).toBe('BUY')
    expect(dossier.dataQuality.missing).toEqual([])
  })
  it('degrades a failing source to ok:false with a note instead of throwing', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    ;(yahoo.getFinancialMetrics as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const d = await buildResearchDossier('NVDA', baseOpts) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { fundamentals: unknown }>
    expect(d.fundamentals.ok).toBe(false)
    expect(d.dataQuality.missing).toContain('fundamentals')
  })
  it('notes when there is no recent agents run', async () => {
    const rq = await import('../../server/lib/agents/runs-query')
    ;(rq.getLatestRunForSymbol as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const d = await buildResearchDossier('NVDA', baseOpts) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { agentsVerdict: unknown }>
    expect(d.agentsVerdict.ok).toBe(false)
    expect(d.agentsVerdict.note).toMatch(/run the agents/i)
  })
  it('adds a managementWeb section for the management preset', async () => {
    const d = await buildResearchDossier('NVDA', { ...baseOpts, preset: 'management', person: 'Jensen Huang' }) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { managementWeb?: unknown }>
    expect(d.managementWeb?.ok).toBe(true)
  })
})
