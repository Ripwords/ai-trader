import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertReturning = vi.fn()
const updateSet = vi.fn()
const updateWhere = vi.fn()
const selectLimit = vi.fn()

vi.mock('../../db/client', () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ returning: insertReturning }) }),
    update: () => ({ set: updateSet }),
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  }),
}))

vi.mock('../../server/db/repo', () => ({
  getOwnerId: vi.fn().mockResolvedValue('owner-id'),
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    readBody: vi.fn(async (event: { _body?: unknown }) => event._body),
  }
})

type PostHandler = (event: H3Event) => Promise<ReadableStream<Uint8Array>>
let handler: PostHandler

beforeEach(async () => {
  vi.resetModules()
  insertReturning.mockReset()
  updateSet.mockReset()
  updateWhere.mockReset()
  selectLimit.mockReset()

  insertReturning.mockResolvedValue([
    { id: 'run-1', symbol: 'NVDA', tradeDate: '2026-05-10' },
  ])
  updateSet.mockReturnValue({ where: updateWhere })
  updateWhere.mockResolvedValue(undefined)
  selectLimit.mockResolvedValue([])

  process.env.NUXT_API_BASE_URL = 'http://api:8000'
  process.env.INTERNAL_BEARER = 'sek'

  // Stub global fetch so the upstream returns a small NDJSON ReadableStream.
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode('{"type":"run-start","run_id":"r","symbol":"NVDA","config":{}}\n'),
        )
        controller.enqueue(
          enc.encode('{"type":"run-end","run_id":"r","tokens_in":0,"tokens_out":0,"cost_usd":0}\n'),
        )
        controller.close()
      },
    })
    return { ok: true, body, status: 200 }
  })

  const mod = await import('../../server/api/research/agents-run.post')
  handler = mod.default as PostHandler
})

function makeEvent(body: unknown): H3Event {
  const setHeader = vi.fn()
  return {
    node: { res: { setHeader } },
    headers: {},
    method: 'POST',
    _body: body,
    context: {},
  } as unknown as H3Event
}

describe('POST /api/research/agents-run', () => {
  it('inserts an agent_runs row and returns a ReadableStream', async () => {
    const event = makeEvent({ symbol: 'NVDA', max_debate_rounds: 1 })
    const stream = await handler(event)
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(insertReturning).toHaveBeenCalledTimes(1)
  })

  it('rejects when symbol is missing', async () => {
    const event = makeEvent({})
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })
})
