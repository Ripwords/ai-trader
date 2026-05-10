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

describe('useAgentsRun.loadFromHistory — refresh-survival', () => {
  it('rehydrates events + status from /api/research/agent-messages', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        runId: 'r-7',
        status: 'complete',
        finishedAt: '2026-05-10T00:00:00Z',
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
  })

  it('marks status failed when the messages endpoint errors', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }))
    const run = useAgentsRun()
    await run.loadFromHistory('missing')
    expect(run.status.value).toBe('failed')
    expect(run.error.value).toContain('failed to load')
  })
})
