import { describe, it, expect, vi } from 'vitest'
import { parseNdjsonChunk, useAgentsRun } from '../../composables/useAgentsRun'
import type { AgentEvent } from '../../types/agents'

describe('parseNdjsonChunk', () => {
  it('emits complete events and buffers a partial trailing line', () => {
    const out: AgentEvent[] = []
    const buf1 = parseNdjsonChunk('', '{"type":"run-start","run_id":"r","symbol":"NVDA","config":{}}\n{"type":"node-start","no', out)
    expect(out.length).toBe(1)
    expect(out[0].type).toBe('run-start')
    expect(buf1).toBe('{"type":"node-start","no')

    const buf2 = parseNdjsonChunk(buf1, 'de":"trader"}\n', out)
    expect(out.length).toBe(2)
    expect(out[1].type).toBe('node-start')
    expect(buf2).toBe('')
  })

  it('skips empty lines', () => {
    const out: AgentEvent[] = []
    parseNdjsonChunk('', '\n\n{"type":"run-end","run_id":"r","tokens_in":0,"tokens_out":0,"cost_usd":0}\n\n', out)
    expect(out.length).toBe(1)
  })
})

describe('useAgentsRun.start — concurrent-run guard', () => {
  it('surfaces 409 with existing run_id and does NOT enter running state', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ data: { run_id: 'existing-7' } }),
    }))
    const run = useAgentsRun()
    await run.start('NVDA')
    expect(run.status.value).toBe('failed')
    expect(run.runId.value).toBe('existing-7')
    expect(run.error.value).toContain('existing-7')
    expect(run.events.value).toEqual([])
  })
})

describe('useAgentsRun.start — canonical-resolution gate (422)', () => {
  it('surfaces ambiguous candidates and does NOT enter running state', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: false,
      status: 422,
      json: async () => ({
        data: {
          status: 'ambiguous',
          candidates: [
            { moomoo: 'US.MU', yahoo: 'MU', name: 'Micron Technology, Inc.', exchange: 'NASDAQ', type: 'Equity' },
          ],
        },
      }),
    }))
    const run = useAgentsRun()
    await run.start('MU')
    expect(run.status.value).toBe('failed')
    expect(run.events.value).toEqual([])
    expect(run.resolution.value).toMatchObject({ status: 'ambiguous' })
    expect(run.error.value?.toLowerCase()).toContain('pick')
  })
})

describe('useAgentsRun.loadFromHistory — refresh-survival', () => {
  it('rehydrates events + status + startedAt from /api/research/agent-messages', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        runId: 'r-7',
        status: 'complete',
        startedAt: '2026-05-10T12:00:00Z',
        finishedAt: '2026-05-10T12:01:30Z',
        lastSeq: 3,
        events: [
          { type: 'run-start', run_id: 'r-7', symbol: 'NVDA', config: {} },
          { type: 'node-start', node: 'fundamentals_analyst' },
          { type: 'decision', rating: 'buy', confidence: 70, rationale: 'ok' },
          { type: 'run-end', run_id: 'r-7', tokens_in: 1, tokens_out: 1, cost_usd: 0.01 },
        ],
      }),
    }))

    const run = useAgentsRun()
    await run.loadFromHistory('r-7')

    expect(run.runId.value).toBe('r-7')
    expect(run.status.value).toBe('complete')
    expect(run.events.value.length).toBe(4)
    expect(run.verdict.value).toMatchObject({ rating: 'buy', confidence: 70 })
    // startedAt comes from agent_runs.started_at, not Date.now() — so a
    // refreshed page sees the original wall-clock start, and the elapsed
    // counter shows cumulative seconds.
    expect(run.startedAt.value).toBeInstanceOf(Date)
    expect(run.startedAt.value?.toISOString()).toBe('2026-05-10T12:00:00.000Z')
  })

  it('resets to idle when the run is not found (stale URL)', async () => {
    // 404 = the run doesn't exist (deleted, or URL from before a DB reset).
    // Better UX than a scary error banner: drop back to the Run button so the
    // user can start a fresh run.
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    const run = useAgentsRun()
    await run.loadFromHistory('missing')
    expect(run.status.value).toBe('idle')
    expect(run.runId.value).toBeNull()
    expect(run.error.value).toBeNull()
  })

  it('marks status failed when the messages endpoint errors with non-404', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    const run = useAgentsRun()
    await run.loadFromHistory('r-9')
    expect(run.status.value).toBe('failed')
    expect(run.error.value).toContain('failed to load')
  })
})
