import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { trimHistory } from '../../server/llm/chat-history'

const user = (text: string): ModelMessage => ({ role: 'user', content: text })
const call = (id: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'research_dossier', input: { symbol: 'NVDA' } }] })
const result = (id: string): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'research_dossier', output: { type: 'json', value: { big: 'x'.repeat(1000) } } }] })
const said = (text: string): ModelMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })

const toolIds = (messages: ModelMessage[]) => messages.flatMap(m =>
  typeof m.content === 'string' ? [] : m.content.flatMap(p => 'toolCallId' in p ? [p.toolCallId] : []))

describe('trimHistory', () => {
  const thread = [
    user('dossier on NVDA'), call('t1'), result('t1'), said('NVDA summary'),
    user('and AMD?'), call('t2'), result('t2'), said('AMD summary'),
    user('compare their margins'),
  ]

  it('drops tool data from turns before the previous one, so a long thread does not resend every old dossier', () => {
    const out = trimHistory(thread)
    expect(toolIds(out)).toEqual(['t2', 't2'])
  })

  it('keeps every answer the model gave, so it still knows what it concluded', () => {
    const out = trimHistory(thread)
    expect(out.filter(m => m.role === 'assistant').flatMap(m => typeof m.content === 'string' ? [] : m.content)
      .filter(p => p.type === 'text').map(p => 'text' in p ? p.text : '')).toEqual(['NVDA summary', 'AMD summary'])
    expect(out.filter(m => m.role === 'user')).toHaveLength(3)
  })

  it('leaves a short thread alone', () => {
    const short = [user('dossier on NVDA'), call('t1'), result('t1'), said('NVDA summary'), user('why?')]
    expect(trimHistory(short)).toEqual(short)
  })
})
