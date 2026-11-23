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

  it('looks for a reusable run before every debate', () => {
    expect(rule()).toMatch(/call research_get with the symbol before any agents_debate call/)
  })

  it('reports the cap, both cases and the run link, and keeps the 7-day probability from reading as conviction', () => {
    expect(rule()).toMatch(/rating_cap is set, the capped rating stands even over an owner_verdict of add: say the agents reached original_rating/)
    expect(rule()).toMatch(/When owner_verdict is set, lead with it/)
    expect(rule()).toMatch(/the bull case and the bear case in one line each/)
    expect(rule()).toMatch(/a markdown link to run_url/)
    expect(rule()).toMatch(/add no host/)
    expect(rule()).toMatch(/never as conviction in the long-term thesis/)
    expect(body).not.toMatch(/rating\/confidence\/rationale/)
  })

  it('reports a run with multiples but no DCF fair value as that, not as unvalued', () => {
    expect(rule()).toMatch(/valuation\.status is multiples_only or discarded/)
    expect(rule()).toMatch(/never say the stock was not valued/)
  })

  it('tells the owner a debate is starting and that it takes minutes', () => {
    expect(rule()).toMatch(/in the same message as the agents_debate call/)
    expect(rule()).toMatch(/takes several minutes/)
    expect(section('REPLY STYLE', 'PORTFOLIO SCOPE')).toMatch(/one exception: the one-line notice before a debate/)
  })

  it('never describes a debate as taking seconds', () => {
    expect(body).not.toMatch(/30-60s|30-90s/)
    expect(section('RESEARCH (agents_debate):', 'DEBATE BEFORE A BUY')).toMatch(/minutes, not seconds/)
  })

  it('caps debates per turn so a screen cannot launch one per row', () => {
    expect(rule()).toMatch(/1 debate per turn/)
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

  it('carries the buy rule in the tool descriptions, which a saved prompt override cannot drop', () => {
    const tools = makeTools({} as ApiClient)
    expect(tools.agents_debate!.description).toMatch(/before recommending that the user buy or add/)
    expect(tools.research_start!.description).toMatch(/verdict in this turn/)
    expect(tools.research_get!.description).toContain('age_days')
  })

  it('names the verdict fields the two research tools return', () => {
    const tools = makeTools({} as ApiClient)
    for (const name of ['agents_debate', 'research_get']) {
      for (const field of ['rating_cap', 'bull_case', 'bear_case', 'run_url', 'no_verdict_reason']) {
        expect(tools[name]!.description, name).toContain(field)
      }
    }
    expect(tools.research_get!.description).toContain('latest_attempt')
  })

  it('describes the plan tools by the fields they return', () => {
    const tools = makeTools({} as ApiClient)
    expect(tools.planning_get!.description).toContain('investable_total')
    expect(tools.planning_get!.description).not.toMatch(/settings holds/)
    expect(tools.planning_update!.description).toContain('locked_symbols')
    expect(tools.portfolio_rebalance_plan!.description).toMatch(/Whole-lot trades/)
    expect(tools.portfolio_rebalance_plan!.description).toContain('lot_size')
    expect(body).toContain('below_one_lot')
    expect(body).not.toContain('below_one_share')
    expect(tools.portfolio_rebalance_plan!.description).not.toMatch(/symbol null/)
    expect(body).not.toMatch(/symbol null/)
    expect(body).toContain('investable_total')
  })

  it('describes a run as taking minutes in both research tools', () => {
    const tools = makeTools({} as ApiClient)
    expect(tools.agents_debate!.description).toMatch(/minutes, not seconds/)
    expect(tools.research_start!.description).toMatch(/takes minutes/)
    expect(tools.research_start!.description).not.toMatch(/30-90s/)
  })

  const verdict = (runId: string) => ({ runId, symbol: 'US.NVDA', status: 'complete', rating: 'buy', confidence: 71, age_days: 3 })
  const mockRuns = (over: Record<string, unknown>) => {
    vi.doMock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
    vi.doMock('../../server/lib/agents/runs-query', () => ({
      getRunVerdict: vi.fn(async (_u: string, runId: string) => verdict(runId)),
      getLatestRunForSymbol: vi.fn(async () => null),
      getLatestAttemptForSymbol: vi.fn(async () => null),
      ...over,
    }))
  }

  it('returns the stored verdict for a runId, age included', async () => {
    mockRuns({})
    const out = await makeTools({} as ApiClient).research_get!.execute({ runId: 'run-1' }, {})
    expect(out).toEqual(verdict('run-1'))
  })

  it('says so when the run does not exist', async () => {
    mockRuns({ getRunVerdict: vi.fn(async () => null) })
    const out = await makeTools({} as ApiClient).research_get!.execute({ runId: 'run-1' }, {})
    expect(out).toEqual({ error: 'run not found', runId: 'run-1' })
  })

  it('finds a run stored under the resolved symbol when the stored symbol does not match what was asked', async () => {
    const latest = vi.fn(async (_u: string, symbol: string) =>
      symbol === 'US.BRK.B' ? { runId: 'run-7', symbol } : null)
    mockRuns({ getLatestRunForSymbol: latest })
    vi.doMock('../../server/lib/yahoo', () => ({
      resolveSymbol: async () => ({ status: 'resolved', symbol: 'US.BRK.B' }),
    }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ symbol: 'BRK-B' }, {})
    expect(out).toMatchObject({ runId: 'run-7' })
    expect(out).not.toHaveProperty('latest_attempt')
  })

  it('reports a newer failed attempt beside the latest complete verdict, not in its place', async () => {
    const attempt = { runId: 'run-9', status: 'failed', error: 'agents service unreachable', startedAt: '2026-11-20T10:00:00.000Z' }
    mockRuns({
      getLatestRunForSymbol: vi.fn(async () => ({ runId: 'run-7', symbol: 'US.NVDA' })),
      getLatestAttemptForSymbol: vi.fn(async () => attempt),
    })
    const out = await makeTools({} as ApiClient).research_get!.execute({ symbol: 'NVDA' }, {})
    expect(out).toEqual({ ...verdict('run-7'), latest_attempt: attempt })
  })

  it('reports the run in progress when the symbol has no finished run', async () => {
    mockRuns({
      getRunVerdict: vi.fn(async (_u: string, runId: string) => ({ runId, status: 'running', rating: null })),
      getLatestAttemptForSymbol: vi.fn(async () => ({ runId: 'run-9', status: 'running', error: null, startedAt: '2026-11-20T10:00:00.000Z' })),
    })
    vi.doMock('../../server/lib/yahoo', () => ({ resolveSymbol: async () => ({ status: 'resolved', symbol: 'NVDA' }) }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ symbol: 'NVDA' }, {})
    expect(out).toEqual({ runId: 'run-9', status: 'running', rating: null })
  })

  it('says so when the symbol has no run at all', async () => {
    mockRuns({})
    vi.doMock('../../server/lib/yahoo', () => ({ resolveSymbol: async () => ({ status: 'resolved', symbol: 'NVDA' }) }))
    const out = await makeTools({} as ApiClient).research_get!.execute({ symbol: 'NVDA' }, {})
    expect(out).toEqual({ error: 'no research run found for symbol', symbol: 'NVDA' })
  })
})
