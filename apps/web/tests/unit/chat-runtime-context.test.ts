import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'
import { formatCurrentDateTime } from '../../server/lib/prompts/chat-runtime'
import { webDefault } from '../../server/lib/prompts/registry'

describe('formatCurrentDateTime', () => {
  const at = new Date('2026-10-17T05:40:00Z')

  it('renders the time in the user zone with its UTC offset', () => {
    expect(formatCurrentDateTime(at, 'Asia/Kuala_Lumpur'))
      .toBe('Current date/time: Sat 17 Oct 2026 13:40 (Asia/Kuala_Lumpur, UTC+08:00).')
  })

  it('renders UTC as +00:00 and a half-hour zone correctly', () => {
    expect(formatCurrentDateTime(at, 'UTC')).toBe('Current date/time: Sat 17 Oct 2026 05:40 (UTC, UTC+00:00).')
    expect(formatCurrentDateTime(at, 'Asia/Kolkata')).toBe('Current date/time: Sat 17 Oct 2026 11:10 (Asia/Kolkata, UTC+05:30).')
  })

  it('uses a 24-hour clock around midnight', () => {
    expect(formatCurrentDateTime(new Date('2026-10-17T16:05:00Z'), 'Asia/Kuala_Lumpur'))
      .toBe('Current date/time: Sun 18 Oct 2026 00:05 (Asia/Kuala_Lumpur, UTC+08:00).')
  })
})

describe('buildSystemPrompt — editable body plus runtime block', () => {
  it('uses the default body and rules when none are passed', () => {
    const p = buildSystemPrompt('ok')
    expect(p.startsWith(webDefault('chat.system'))).toBe(true)
    expect(p).toContain(webDefault('chat.moomoo_rules'))
  })

  it('appends the runtime parts after the editable text, inside a delimited block', () => {
    const p = buildSystemPrompt('not_configured', 'run 42 for NVDA', {
      body: 'CUSTOM BODY',
      moomooRules: 'CUSTOM RULES',
      currentDateTime: 'Current date/time: Sat 17 Oct 2026 13:40 (Asia/Kuala_Lumpur, UTC+08:00).',
    })
    const runtimeAt = p.indexOf('RUNTIME CONTEXT')
    expect(p.startsWith('CUSTOM BODY')).toBe(true)
    expect(p.indexOf('CUSTOM RULES')).toBeLessThan(runtimeAt)
    const runtime = p.slice(runtimeAt)
    expect(runtime).toContain('Current date/time: Sat 17 Oct 2026 13:40')
    expect(runtime).toContain('Ghostfolio tracker tools are NOT enabled')
    expect(runtime).toContain('use the moomoo trade_* tools - that is the only broker data')
    expect(runtime).toContain('RECENT RESEARCH RUNS')
    expect(runtime).toContain('run 42 for NVDA')
    expect(p).not.toContain(webDefault('chat.system').slice(0, 40))
  })

  it('omits the recall heading when there is no recall', () => {
    expect(buildSystemPrompt('ok')).not.toContain('RECENT RESEARCH RUNS (for tickers')
  })
})

describe('chat.system default — notification and reminder guidance', () => {
  const body = webDefault('chat.system')

  it('says price alerts are delivered by email, push and the in-app popup', () => {
    const alerts = body.slice(body.indexOf('PRICE ALERTS'))
    expect(alerts).toMatch(/every minute/)
    expect(alerts).toMatch(/email/)
    expect(alerts).toMatch(/Settings → Notifications/)
    expect(alerts).toMatch(/push/)
  })

  it('documents the reminder tools and how to resolve relative times', () => {
    expect(body).toContain('reminder_create')
    expect(body).toContain('reminder_list')
    expect(body).toContain('reminder_cancel')
    expect(body).toMatch(/ISO 8601/)
    expect(body).toMatch(/Current date\/time/)
    expect(body).toMatch(/confirm/i)
  })

  it('says a finished research run also emails and pushes', () => {
    const recall = body.slice(body.indexOf('RESEARCH RECALL & ASYNC RUNS'), body.indexOf('Never invent symbols'))
    expect(recall).toMatch(/email/)
    expect(recall).toMatch(/push/)
  })
})
