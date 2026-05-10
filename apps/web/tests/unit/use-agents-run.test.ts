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
