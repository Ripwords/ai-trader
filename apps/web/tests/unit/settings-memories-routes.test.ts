import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MEMORY_LIMIT, MEMORY_MAX_CHARS, type MemorySource, type MemoryView } from '../../types/memory'

const store = vi.hoisted(() => ({
  listMemories: vi.fn(),
  addMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
}))
vi.mock('../../server/lib/chat-memory', () => store)
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return {
    ...actual,
    readBody: (e: { _body: unknown }) => Promise.resolve(e._body),
    getRouterParam: (e: { _params: Record<string, string> }, k: string) => e._params[k],
  }
})

type Handler = (e: H3Event) => Promise<unknown>
const list = (await import('../../server/api/settings/memories/index.get')).default as Handler
const post = (await import('../../server/api/settings/memories/index.post')).default as Handler
const put = (await import('../../server/api/settings/memories/[id].put')).default as Handler
const del = (await import('../../server/api/settings/memories/[id].delete')).default as Handler

const event = (opts: { body?: unknown; id?: string } = {}) =>
  ({ _body: opts.body, _params: opts.id ? { id: opts.id } : {}, context: {} }) as unknown as H3Event

const view = (content: string, source: MemorySource = 'manual'): MemoryView =>
  ({ id: 'm1', content, source, updatedAt: '2026-11-22T00:00:00.000Z' })

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
})

describe('GET /api/settings/memories', () => {
  it('lists the owner\'s memories with the limit', async () => {
    store.listMemories.mockResolvedValue([view('USD exposure is intentional.')])
    await expect(list(event())).resolves.toEqual({ memories: [view('USD exposure is intentional.')], limit: MEMORY_LIMIT })
    expect(store.listMemories).toHaveBeenCalledWith('user-1')
  })
})

describe('POST /api/settings/memories', () => {
  it('saves the owner\'s text, tidied, as a manual memory', async () => {
    store.addMemory.mockResolvedValue({ memory: view('USD exposure is intentional.') })
    await expect(post(event({ body: { content: '  USD exposure\n is intentional. ' } })))
      .resolves.toEqual({ memory: view('USD exposure is intentional.') })
    expect(store.addMemory).toHaveBeenCalledWith('user-1', 'USD exposure is intentional.', 'manual')
  })

  it('rejects empty and overlong text with the reason, before touching the store', async () => {
    await expect(post(event({ body: { content: '   ' } }))).rejects.toMatchObject({ statusCode: 400, statusMessage: 'A memory cannot be empty.' })
    await expect(post(event({ body: { content: 'x'.repeat(MEMORY_MAX_CHARS + 1) } })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: `A memory can be at most ${MEMORY_MAX_CHARS} characters.` })
    await expect(post(event({ body: {} }))).rejects.toMatchObject({ statusCode: 400 })
    expect(store.addMemory).not.toHaveBeenCalled()
  })

  it('says when memory is full or the text is already saved', async () => {
    store.addMemory.mockResolvedValueOnce({ error: 'full' })
    await expect(post(event({ body: { content: 'x' } }))).rejects.toMatchObject({ statusCode: 409, statusMessage: expect.stringContaining('Memory is full') })
    store.addMemory.mockResolvedValueOnce({ error: 'duplicate' })
    await expect(post(event({ body: { content: 'x' } }))).rejects.toMatchObject({ statusCode: 409, statusMessage: 'That memory is already saved.' })
  })
})

describe('PUT /api/settings/memories/:id', () => {
  it('rewrites a memory as the owner\'s own', async () => {
    store.updateMemory.mockResolvedValue({ memory: view('Tech concentration is acknowledged.') })
    await expect(put(event({ id: 'm1', body: { content: 'Tech concentration is acknowledged.' } })))
      .resolves.toEqual({ memory: view('Tech concentration is acknowledged.') })
    expect(store.updateMemory).toHaveBeenCalledWith('user-1', 'm1', 'Tech concentration is acknowledged.', 'manual')
  })

  it('answers 404 for a memory that is gone', async () => {
    store.updateMemory.mockResolvedValue({ error: 'not_found' })
    await expect(put(event({ id: 'gone', body: { content: 'x' } }))).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('DELETE /api/settings/memories/:id', () => {
  it('deletes, and succeeds again when the memory is already gone', async () => {
    store.deleteMemory.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(del(event({ id: 'm1' }))).resolves.toEqual({ ok: true })
    await expect(del(event({ id: 'm1' }))).resolves.toEqual({ ok: true })
    expect(store.deleteMemory).toHaveBeenCalledWith('user-1', 'm1')
  })
})
