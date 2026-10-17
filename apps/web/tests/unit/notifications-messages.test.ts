import { describe, expect, it } from 'vitest'
import {
  chatReplyMessage,
  emailShell,
  escapeHtml,
  pushPayload,
  reminderMessage,
  researchRunMessage,
  testMessage,
} from '../../server/lib/notifications-messages'
import type { Reminder } from '../../server/lib/reminders-core'

const reminder: Reminder = {
  id: 'r1',
  createdAt: '2026-10-16T00:00:00.000Z',
  dueAt: '2026-10-17T01:00:00.000Z',
  message: 'Check NVDA earnings & guidance',
  symbol: 'US.NVDA',
  status: 'scheduled',
  sentAt: null,
}

describe('emailShell', () => {
  it('declares UTF-8 so separators like · render as themselves', () => {
    expect(emailShell('x')).toContain('<meta charset="utf-8">')
  })
})

describe('escapeHtml', () => {
  it('escapes markup characters', () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})

describe('reminderMessage', () => {
  it('shows the due time in the settings timezone', () => {
    const m = reminderMessage(reminder, 'Asia/Kuala_Lumpur', null)
    expect(m.dedupeKey).toBe('reminder:r1')
    expect(m.subject).toBe('Reminder: Check NVDA earnings & guidance')
    expect(m.bodyText).toContain('09:00')
    expect(m.bodyHtml).toContain('earnings &amp; guidance')
    expect(m.url).toBe('/research/US.NVDA')
  })

  it('truncates a long message in the subject only', () => {
    const long = 'x'.repeat(200)
    const m = reminderMessage({ ...reminder, message: long, symbol: null }, 'UTC', null)
    expect(m.subject.length).toBeLessThanOrEqual(90)
    expect(m.bodyText).toContain(long)
    expect(m.url).toBe('/portfolio')
  })
})

describe('researchRunMessage', () => {
  it('carries rating, confidence and a rationale excerpt for a finished run', () => {
    const m = researchRunMessage({
      runId: 'run-1',
      symbol: 'US.AAPL',
      status: 'complete',
      error: null,
      decision: { rating: 'BUY', confidence: 72, rationale: '**Strong** services growth. '.repeat(40) },
    }, 'https://t.example.com/')
    expect(m.dedupeKey).toBe('run:run-1')
    expect(m.subject).toBe('US.AAPL research done: BUY · confidence 72')
    expect(m.bodyText).toContain('Strong services growth')
    expect(m.bodyText).not.toContain('**')
    expect(m.bodyText.length).toBeLessThan(800)
    expect(m.url).toBe('/research/US.AAPL?run=run-1')
    expect(m.bodyHtml).toContain('https://t.example.com/research/US.AAPL?run=run-1')
  })

  it('reports a failed or cancelled run without a verdict', () => {
    expect(researchRunMessage({ runId: 'r', symbol: 'US.AAPL', status: 'failed', error: 'boom', decision: null }, null).subject)
      .toBe('US.AAPL research failed')
    expect(researchRunMessage({ runId: 'r', symbol: 'US.AAPL', status: 'cancelled', error: 'cancelled', decision: null }, null).subject)
      .toBe('US.AAPL research cancelled')
  })
})

describe('chatReplyMessage', () => {
  const reply = { threadId: 'th-1', messageId: 'msg-9', title: 'NVDA earnings', text: 'Hi there', error: null }

  it('titles the push with the thread and opens that chat', () => {
    const m = chatReplyMessage(reply, null)
    expect(m).toMatchObject({ kind: 'chat_reply', dedupeKey: 'chat:msg-9', subject: 'NVDA earnings', url: '/?c=th-1' })
    expect(pushPayload(m)).toMatchObject({ title: 'NVDA earnings', body: 'Hi there', url: '/?c=th-1' })
  })

  it('falls back to the app name when the thread has no title', () => {
    expect(chatReplyMessage({ ...reply, title: null }, null).subject).toBe('ai·trader')
    expect(chatReplyMessage({ ...reply, title: '  ' }, null).subject).toBe('ai·trader')
  })

  it('excerpts the reply as plain text of about 140 characters', () => {
    const text = '## Verdict\n\n**NVDA** looks [cheap](https://x.example) on `forward PE`. '.repeat(10)
    const body = pushPayload(chatReplyMessage({ ...reply, text }, null)).body
    expect(body.startsWith('Verdict NVDA looks cheap on forward PE.')).toBe(true)
    expect(body).not.toMatch(/[#*`[\]]/)
    expect(body.length).toBeLessThanOrEqual(140)
    expect(body.endsWith('…')).toBe(true)
  })

  it('says the reply is ready when it has no text', () => {
    expect(pushPayload(chatReplyMessage({ ...reply, text: '' }, null)).body).toBe('Reply ready')
  })

  it('says the reply failed, with the reason', () => {
    const m = chatReplyMessage({ ...reply, text: 'partial', error: 'The assistant stopped early: 401 invalid api key' }, null)
    expect(pushPayload(m).body).toBe('Reply failed. The assistant stopped early: 401 invalid api key')
  })
})

describe('testMessage', () => {
  it('gets a unique dedupe key per call', () => {
    expect(testMessage(null).dedupeKey).not.toBe(testMessage(null).dedupeKey)
  })
})

describe('pushPayload', () => {
  it('always carries a visible title and body', () => {
    const p = pushPayload({ subject: 'Hi', bodyText: 'line one\nline two', url: '/portfolio', dedupeKey: 'alert:a1' })
    expect(p).toEqual({ title: 'Hi', body: 'line one line two', url: '/portfolio', tag: 'alert:a1' })
  })

  it('uses only the first paragraph as the body', () => {
    expect(pushPayload({ subject: 'Hi', bodyText: 'summary\n\ndetails', url: null, dedupeKey: 'k' }).body).toBe('summary')
    expect(pushPayload({ subject: 'Hi', bodyText: '', url: null, dedupeKey: 'k' }).body).toBe('New notification')
  })
})
