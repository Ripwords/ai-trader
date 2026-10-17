import { describe, expect, it, vi } from 'vitest'
import { createScheduledJob } from '../../server/lib/scheduler'
import { describeHeartbeat, HEARTBEAT_STALE_MS } from '../../types/scheduler'

const NOW = Date.parse('2026-10-17T01:00:00.000Z')

describe('describeHeartbeat', () => {
  it('reads "never" before the first run', () => {
    expect(describeHeartbeat(undefined, NOW)).toEqual({ label: 'never checked', stale: true, ok: false, error: null })
  })

  it('reports how long ago the last run was', () => {
    const entry = { lastRunAt: new Date(NOW - 40_000).toISOString(), lastOk: true, lastError: null }
    expect(describeHeartbeat(entry, NOW)).toEqual({ label: 'last checked 40s ago', stale: false, ok: true, error: null })
    expect(describeHeartbeat({ ...entry, lastRunAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW).label).toBe('last checked 5 min ago')
  })

  it('goes stale after three minutes', () => {
    const at = (ms: number) => ({ lastRunAt: new Date(NOW - ms).toISOString(), lastOk: true, lastError: null })
    expect(describeHeartbeat(at(HEARTBEAT_STALE_MS - 1000), NOW).stale).toBe(false)
    expect(describeHeartbeat(at(HEARTBEAT_STALE_MS + 1000), NOW).stale).toBe(true)
  })

  it('surfaces the last error', () => {
    const entry = { lastRunAt: new Date(NOW).toISOString(), lastOk: false, lastError: 'db down' }
    expect(describeHeartbeat(entry, NOW)).toMatchObject({ ok: false, error: 'db down' })
  })
})

describe('createScheduledJob', () => {
  it('records a successful run', async () => {
    const record = vi.fn(async () => {})
    await createScheduledJob('alerts:evaluate', async () => {}, { timeoutMs: 1000, record })()
    expect(record).toHaveBeenCalledWith('alerts:evaluate', expect.objectContaining({ lastOk: true, lastError: null }))
  })

  it('records a failed run and never throws', async () => {
    const record = vi.fn(async () => {})
    const job = createScheduledJob('notify:send', async () => { throw new Error('db down') }, { timeoutMs: 1000, record })
    await expect(job()).resolves.toBeUndefined()
    expect(record).toHaveBeenCalledWith('notify:send', expect.objectContaining({ lastOk: false, lastError: 'db down' }))
  })

  it('records a timed-out run and frees the slot for the next one', async () => {
    const record = vi.fn(async () => {})
    let calls = 0
    const job = createScheduledJob('reminders:dispatch', () => {
      calls++
      return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    }, { timeoutMs: 20, record })
    await job()
    expect(record).toHaveBeenCalledWith('reminders:dispatch', expect.objectContaining({ lastOk: false, lastError: expect.stringMatching(/timed out/) }))
    await job()
    expect(calls).toBe(2)
  })

  it('does not overlap runs', async () => {
    let release!: () => void
    const run = vi.fn(() => new Promise<void>((r) => { release = r }))
    const job = createScheduledJob('alerts:evaluate', run, { timeoutMs: 1000, record: async () => {} })
    const first = job()
    await job()
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await first
  })

  it('survives a heartbeat write failure', async () => {
    const job = createScheduledJob('alerts:evaluate', async () => {}, { timeoutMs: 1000, record: async () => { throw new Error('db down') } })
    await expect(job()).resolves.toBeUndefined()
  })
})
