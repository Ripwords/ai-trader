import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { changedWatchlist, copyableText, editTarget } from '../../app/lib/chat-actions'

describe('copyableText', () => {
  it('copies the answer text only, without reasoning or tool calls', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'thinking about RHB', state: 'done' },
        { type: 'text', text: 'RHB last traded at RM7.20.', state: 'done' },
        { type: 'tool-market_kline', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
        { type: 'text', text: 'It is down 1.6% on the week.', state: 'done' },
      ],
    } as UIMessage
    expect(copyableText(message)).toBe('RHB last traded at RM7.20.\n\nIt is down 1.6% on the week.')
  })

  it('is empty for a reply that is only tool cards', () => {
    expect(copyableText({ id: 'a2', role: 'assistant', parts: [{ type: 'step-start' }] } as UIMessage)).toBe('')
  })
})

describe('editTarget', () => {
  const user = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: id }] })
  const reply = (id: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: id }] })

  it('edits the question being edited when it is still in the thread', () => {
    expect(editTarget([user('u1'), reply('a1')], 'u1')).toBe('u1')
  })

  it('sends a new question when the one being edited is gone (another chat opened), instead of throwing', () => {
    expect(editTarget([user('u9')], 'u1')).toBeUndefined()
    expect(editTarget([user('u1')], null)).toBeUndefined()
  })

  it('never edits a reply', () => {
    expect(editTarget([user('u1'), reply('a1')], 'a1')).toBeUndefined()
  })
})

describe('changedWatchlist', () => {
  const reply = (...parts: unknown[]) => ({ id: 'a1', role: 'assistant', parts } as UIMessage)

  it('is true when the reply added or removed a watchlist code', () => {
    expect(changedWatchlist(reply({ type: 'tool-watchlist_add', toolCallId: 't', state: 'output-available', input: {}, output: { ok: true } }))).toBe(true)
    expect(changedWatchlist(reply({ type: 'tool-watchlist_remove', toolCallId: 't', state: 'output-available', input: {}, output: { ok: true } }))).toBe(true)
  })

  it('is false for a failed call or any other tool', () => {
    expect(changedWatchlist(reply({ type: 'tool-watchlist_add', toolCallId: 't', state: 'output-error', input: {}, errorText: 'no' }))).toBe(false)
    expect(changedWatchlist(reply({ type: 'tool-get_quote', toolCallId: 't', state: 'output-available', input: {}, output: {} }))).toBe(false)
    expect(changedWatchlist(undefined)).toBe(false)
  })
})
