import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import { webDefault } from '../../server/lib/prompts/registry'

type ToolMap = Record<string, {
  description?: string
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
}>

const body = webDefault('chat.system')

function section(start: string, end: string): string {
  const from = body.indexOf(start)
  const to = body.indexOf(end, from + start.length)
  expect(from, `section "${start}" is missing`).toBeGreaterThan(-1)
  expect(to, `"${end}" must follow "${start}"`).toBeGreaterThan(from)
  return body.slice(from, to)
}

describe('chat.system default: debate before a buy', () => {
  const rule = () => section('DEBATE BEFORE A BUY', 'EARNINGS & FINANCIAL EVENTS:')

  it('tells the model to run the debate unprompted, inline', () => {
    expect(rule()).toMatch(/unprompted/i)
    expect(rule()).toContain('agents_debate')
    expect(rule()).toMatch(/not research_start/)
  })

  it('reuses a finished run inside the freshness window instead of re-running', () => {
    expect(rule()).toContain('research_get')
    expect(rule()).toMatch(/age_days is 7 or less/)
  })

  it('caps debates per turn so a screen cannot launch one per row', () => {
    expect(rule()).toMatch(/at most 2 per turn/)
    expect(rule()).toMatch(/shortlist/i)
  })

  it('exempts facts, screens and an order the user already decided on', () => {
    expect(rule()).toMatch(/already decided/)
    expect(rule()).toMatch(/TRADE WRITES/)
  })

  it('surfaces a disagreeing verdict and labels a recommendation with no debate behind it', () => {
    expect(rule()).toMatch(/first lines/)
    expect(rule()).toContain('not debate-backed')
  })

  it('no longer limits the debate to an explicit request', () => {
    expect(section('RESEARCH (agents_debate):', 'DEBATE BEFORE A BUY')).toMatch(/without being asked/)
  })
})

describe('chat.system default: reply style', () => {
  const style = () => section('REPLY STYLE', 'PORTFOLIO SCOPE')

  it('leads with the answer and cuts the wrapping', () => {
    expect(style()).toMatch(/Answer first/)
    expect(style()).toMatch(/No preamble/)
    expect(style()).toMatch(/not financial advice/)
  })

  it('keeps the details: numbers, units and required disclosures survive', () => {
    expect(style()).toMatch(/Dense, not truncated/)
    expect(style()).toMatch(/every number with its unit and currency/)
    expect(style()).toMatch(/are content, not filler/)
  })
})

describe('research tools: buy-gate support', () => {
  let makeTools: (client: ApiClient, arg?: unknown) => ToolMap
  beforeEach(async () => {
    vi.resetModules()
    makeTools = (await import('../../server/llm/tools')).makeTools as unknown as typeof makeTools
  })
  afterEach(() => {
    vi.doUnmock('../../server/db/repo')
    vi.doUnmock('../../server/lib/agents/runs-query')
    vi.doUnmock('../../server/lib/yahoo')
  })

  const assessment = (runId: string, finishedAt: string | null) => ({
    runId, symbol: 'NVDA', status: finishedAt ? 'complete' : 'running', finishedAt,
    rating: finishedAt ? 'buy' : null, confidence: finishedAt ? 71 : null, rationale: null,
  })

  it('carries the buy rule in the tool descriptions, which a saved prompt override cannot drop', () => {
    const tools = makeTools({} as ApiClient)
    expect(tools.agents_debate!.description).toMatch(/before recommending that the user buy or add/)
    expect(tools.research_start!.description).toMatch(/verdict in this turn/)
    expect(tools.research_get!.description).toContain('age_days')
  })

  it('reports how old a finished run is, in whole days', async () => {
    const finishedAt = new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString()
    vi.doMock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
    vi.doMock('../../server/lib/agents/runs-query', () => ({
      getRunAssessment: vi.fn(async (_u: string, runId: string) => assessment(runId, finishedAt)),
      getLatestRunForSymbol: vi.fn(async () => null),
    }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ runId: 'run-1' }, {})
    expect(out).toMatchObject({ runId: 'run-1', rating: 'buy', age_days: 3 })
  })

  it('gives a running run no age', async () => {
    vi.doMock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
    vi.doMock('../../server/lib/agents/runs-query', () => ({
      getRunAssessment: vi.fn(async (_u: string, runId: string) => assessment(runId, null)),
      getLatestRunForSymbol: vi.fn(async () => null),
    }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ runId: 'run-1' }, {})
    expect(out).toMatchObject({ status: 'running', age_days: null })
  })

  it('finds a run stored under the resolved symbol when asked with a market prefix', async () => {
    const finishedAt = new Date(Date.now() - 60_000).toISOString()
    const latest = vi.fn(async (_u: string, symbol: string) =>
      symbol === 'NVDA' ? { runId: 'run-7', symbol, status: 'complete', finishedAt, rating: 'buy', confidence: 71 } : null)
    vi.doMock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
    vi.doMock('../../server/lib/agents/runs-query', () => ({
      getRunAssessment: vi.fn(async (_u: string, runId: string) => assessment(runId, finishedAt)),
      getLatestRunForSymbol: latest,
    }))
    vi.doMock('../../server/lib/yahoo', () => ({
      resolveSymbol: async () => ({ status: 'resolved', symbol: 'NVDA' }),
    }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ symbol: 'US.NVDA' }, {})
    expect(out).toMatchObject({ runId: 'run-7', age_days: 0 })
  })
})
