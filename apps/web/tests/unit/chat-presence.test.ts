import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPresenceRegistry, PRESENCE_FRESH_MS, shouldNotifyReply } from '../../server/lib/chat-presence'

const NOW = new Date('2026-10-17T01:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

describe('shouldNotifyReply', () => {
  it('notifies when no client has reported', () => {
    expect(shouldNotifyReply([], NOW)).toBe(true)
  })

  it('stays quiet while a fresh report says the chat is in view', () => {
    expect(shouldNotifyReply([{ away: false, at: ago(10_000) }], NOW)).toBe(false)
  })

  it('notifies when the only fresh report is away', () => {
    expect(shouldNotifyReply([{ away: true, at: ago(1_000) }], NOW)).toBe(true)
  })

  it('treats a report older than the freshness window as gone', () => {
    expect(shouldNotifyReply([{ away: false, at: ago(PRESENCE_FRESH_MS + 1) }], NOW)).toBe(true)
  })

  it('stays quiet when any one client is looking', () => {
    expect(shouldNotifyReply([{ away: true, at: ago(1_000) }, { away: false, at: ago(5_000) }], NOW)).toBe(false)
  })
})

describe('ChatPresenceRegistry', () => {
  it('keeps one report per client, so a backgrounded tab cannot hide a focused one', () => {
    const r = new ChatPresenceRegistry()
    r.report('tab-a', { threadId: 'th-1', away: false }, ago(20_000))
    r.report('tab-b', { threadId: 'th-1', away: true }, ago(1_000))
    expect(r.shouldNotify('th-1', NOW)).toBe(false)
  })

  it('moves a client to the thread it now reports for', () => {
    const r = new ChatPresenceRegistry()
    r.report('tab-a', { threadId: 'th-1', away: false }, ago(2_000))
    r.report('tab-a', { threadId: 'th-2', away: false }, ago(1_000))
    expect(r.shouldNotify('th-1', NOW)).toBe(true)
    expect(r.shouldNotify('th-2', NOW)).toBe(false)
  })

  it('notifies for a thread nobody reported on', () => {
    expect(new ChatPresenceRegistry().shouldNotify('th-9', NOW)).toBe(true)
  })

  it('drops stale reports as new ones arrive', () => {
    const r = new ChatPresenceRegistry()
    r.report('tab-old', { threadId: 'th-1', away: false }, ago(PRESENCE_FRESH_MS * 3))
    r.report('tab-new', { threadId: 'th-2', away: true }, NOW)
    expect(r.size).toBe(1)
  })
})

vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return { ...actual, readRawBody: (e: { _raw: string | undefined }) => Promise.resolve(e._raw) }
})

describe('POST /api/chat/presence', () => {
  let handler: (e: H3Event) => Promise<unknown>
  let presence: typeof import('../../server/lib/chat-presence')['chatPresence']
  beforeEach(async () => {
    vi.resetModules()
    handler = (await import('../../server/api/chat/presence.post')).default as typeof handler
    presence = (await import('../../server/lib/chat-presence')).chatPresence
  })
  const event = (raw: string | undefined) => ({ _raw: raw, context: {}, node: { req: {}, res: {} } }) as unknown as H3Event

  it('records a JSON report', async () => {
    await handler(event(JSON.stringify({ threadId: 'th-1', clientId: 'tab-a', away: false })))
    expect(presence.shouldNotify('th-1', new Date())).toBe(false)
  })

  it('accepts the text/plain body sendBeacon sends', async () => {
    await handler(event(JSON.stringify({ threadId: 'th-1', clientId: 'tab-a', away: false })))
    await handler(event(JSON.stringify({ threadId: 'th-1', clientId: 'tab-a', away: true })))
    expect(presence.shouldNotify('th-1', new Date())).toBe(true)
  })

  it('rejects a malformed body with 400', async () => {
    await expect(handler(event('not json'))).rejects.toMatchObject({ statusCode: 400 })
    await expect(handler(event(JSON.stringify({ threadId: 'th-1', away: 'yes' })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(handler(event(undefined))).rejects.toMatchObject({ statusCode: 400 })
  })
})
