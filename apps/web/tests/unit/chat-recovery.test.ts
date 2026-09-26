import { describe, expect, it, vi } from 'vitest'
import type { ChatStatus, UIMessage } from 'ai'
import { afterRequest, followRunningReply, interruptionOf, reattach, recoverReply, replyEnding, type ResumableChat } from '../../app/lib/chat-recovery'

const user = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'q' }] })
const reply = (id: string, metadata?: unknown): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text: 'a' }],
  ...(metadata ? { metadata } : {}),
})

/** A chat whose resume either replays a reply, finds nothing (204), or fails. */
function fakeChat(messages: UIMessage[], resume: 'replays' | 'nothing' | 'fails'): ResumableChat & { resumed: number } {
  return {
    messages,
    status: 'ready' as ChatStatus,
    error: undefined,
    resumed: 0,
    clearError() {
      if (this.status === 'error') {
        this.status = 'ready'
        this.error = undefined
      }
    },
    async resumeStream() {
      this.resumed++
      if (resume === 'replays') this.messages = [...this.messages, reply('live')]
      if (resume === 'fails') {
        this.status = 'error'
        this.error = new Error('Failed to fetch')
      }
    },
  }
}

describe('replyEnding', () => {
  it('reads a stopped or failed reply from its saved metadata', () => {
    expect(replyEnding(reply('a', { stopped: true }))).toEqual({ kind: 'stopped' })
    expect(replyEnding(reply('a', { error: 'The assistant stopped early: 400' })))
      .toEqual({ kind: 'error', message: 'The assistant stopped early: 400' })
    expect(replyEnding(reply('a'))).toBeNull()
    expect(replyEnding(user('u'))).toBeNull()
  })
})

describe('interruptionOf', () => {
  const base = { status: 'ready' as ChatStatus, error: undefined, settling: false }

  it('reports a live error first', () => {
    expect(interruptionOf({ ...base, status: 'error', error: new Error('network error'), messages: [user('u')] }))
      .toEqual({ kind: 'error', message: 'network error' })
  })

  it('reports a question with no reply once the chat is idle', () => {
    expect(interruptionOf({ ...base, messages: [user('u')] })).toEqual({ kind: 'no-reply' })
    expect(interruptionOf({ ...base, status: 'submitted', messages: [user('u')] })).toBeNull()
    expect(interruptionOf({ ...base, settling: true, messages: [user('u')] })).toBeNull()
  })

  it('reports how the last reply ended', () => {
    expect(interruptionOf({ ...base, messages: [user('u'), reply('a', { stopped: true })] })).toEqual({ kind: 'stopped' })
    expect(interruptionOf({ ...base, messages: [user('u'), reply('a')] })).toBeNull()
    expect(interruptionOf({ ...base, messages: [] })).toBeNull()
  })
})

describe('afterRequest', () => {
  const ended = { isAbort: false, isError: false, isDisconnect: false, finishReason: 'stop', error: undefined, refusedBusy: false }

  it('follows the running reply when the send was refused as busy', () => {
    expect(afterRequest({ ...ended, isError: true, error: new Error('busy (HTTP 409)'), refusedBusy: true })).toBe('follow-running')
  })

  it('recovers from a dropped connection', () => {
    expect(afterRequest({ ...ended, isError: true, isDisconnect: true, error: new TypeError('Failed to fetch') })).toBe('recover')
    expect(afterRequest({ ...ended, isError: true, error: new TypeError('network error') })).toBe('recover')
    expect(afterRequest({ ...ended, isError: true, error: new TypeError('Load failed') })).toBe('recover')
  })

  it('leaves HTTP and model errors on screen', () => {
    expect(afterRequest({ ...ended, isError: true, error: new Error('No model provider is configured. Add one in Settings. (HTTP 409)') })).toBeNull()
    expect(afterRequest({ ...ended, isError: true, error: new Error('Server Error (HTTP 500)') })).toBeNull()
    expect(afterRequest({ ...ended, isError: true, error: new Error('The assistant stopped early: 401') })).toBeNull()
    expect(afterRequest({ ...ended, isError: true, error: new TypeError('Cannot read properties of undefined') })).toBeNull()
  })

  it('recovers a stream that closed without a finish (stopped elsewhere, or cut by a proxy)', () => {
    expect(afterRequest({ ...ended, finishReason: undefined })).toBe('recover')
  })

  it('does nothing after a normal finish or a local stop', () => {
    expect(afterRequest(ended)).toBeNull()
    expect(afterRequest({ ...ended, finishReason: undefined, isAbort: true })).toBeNull()
  })
})

describe('reattach', () => {
  it('reloads the saved reply when the followed stream closed without a finish', async () => {
    const chat = fakeChat([user('u')], 'replays')
    // The first resume follows a reply that is then stopped from another tab;
    // by the second, the server has saved it.
    const replay = chat.resumeStream.bind(chat)
    chat.resumeStream = async () => { if (chat.resumed === 0) await replay(); else chat.resumed++ }
    let cutShort = true
    const reload = vi.fn(async () => { chat.messages = [user('u'), reply('saved', { stopped: true })] })
    await reattach(chat, reload, () => { const c = cutShort; cutShort = false; return c })
    expect(chat.resumed).toBe(2)
    expect(reload).toHaveBeenCalledOnce()
    expect(chat.messages.map(m => m.id)).toEqual(['u', 'saved'])
  })

  it('follows a reply still in progress on the server', async () => {
    const chat = fakeChat([user('u')], 'replays')
    const reload = vi.fn(async () => {})
    await reattach(chat, reload)
    expect(chat.messages.map(m => m.id)).toEqual(['u', 'live'])
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads the thread when the reply finished before it could attach', async () => {
    const chat = fakeChat([user('u')], 'nothing')
    const reload = vi.fn(async () => {})
    await reattach(chat, reload)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('leaves a finished thread alone', async () => {
    const chat = fakeChat([user('u'), reply('a')], 'nothing')
    const reload = vi.fn(async () => {})
    await reattach(chat, reload)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('recoverReply', () => {
  it('drops the partial reply and replays it whole', async () => {
    const chat = fakeChat([user('u'), reply('partial')], 'replays')
    await recoverReply(chat, { reload: async () => {}, online: async () => {} })
    expect(chat.messages.map(m => m.id)).toEqual(['u', 'live'])
  })

  it('waits to be online before its one resume attempt', async () => {
    const chat = fakeChat([user('u'), reply('partial')], 'replays')
    let goOnline!: () => void
    const recovering = recoverReply(chat, { reload: async () => {}, online: () => new Promise<void>(r => { goOnline = r }) })
    await Promise.resolve()
    expect(chat.resumed).toBe(0)
    goOnline()
    await recovering
    expect(chat.resumed).toBe(1)
  })

  it('reloads the saved reply when the server has already finished it', async () => {
    const chat = fakeChat([user('u'), reply('partial')], 'nothing')
    chat.status = 'error'
    chat.error = new Error('network error')
    const reload = vi.fn(async () => {})
    await recoverReply(chat, { reload, online: async () => {} })
    expect(reload).toHaveBeenCalledOnce()
    expect(chat.status).toBe('ready')
  })

  it('leaves the error showing when the resume fails too', async () => {
    const chat = fakeChat([user('u'), reply('partial')], 'fails')
    const reload = vi.fn(async () => {})
    await recoverReply(chat, { reload, online: async () => {} })
    expect(chat.status).toBe('error')
    expect(chat.resumed).toBe(1)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('followRunningReply', () => {
  const saved = [user('u0'), reply('a0'), user('other-tab')]

  it('shows the thread as saved, follows its reply, and hands back a question never saved', async () => {
    const chat = fakeChat([user('u0'), reply('a0'), user('unsent')], 'replays')
    chat.status = 'error'
    const reload = async () => { chat.messages = [...saved] }
    const unsent = await followRunningReply(chat, reload)
    expect(chat.messages.map(m => m.id)).toEqual(['u0', 'a0', 'other-tab', 'live'])
    expect(unsent).toBe('q')
  })

  it('hands back nothing when the refused send was a retry of a saved question', async () => {
    const chat = fakeChat([user('u0'), reply('a0'), user('other-tab')], 'replays')
    chat.status = 'error'
    const unsent = await followRunningReply(chat, async () => { chat.messages = [...saved] })
    expect(unsent).toBeNull()
  })
})
