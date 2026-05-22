import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertReturning = vi.fn()
const insertValues = vi.fn()
const updateSet = vi.fn()
const updateWhere = vi.fn()
const selectLimit = vi.fn()

vi.mock('../../db/client', () => ({
  getDb: () => ({
    insert: () => ({ values: insertValues }),
    update: () => ({ set: updateSet }),
    select: () => ({ from: () => ({ where: () => ({ limit: selectLimit }) }) }),
  }),
}))

vi.mock('../../server/db/repo', () => ({
  getOwnerId: vi.fn().mockResolvedValue('owner-id'),
}))

// The proxy now hard-gates on canonical resolution before any DB/upstream
// work. Default: NVDA resolves cleanly so the existing assertions still hold.
const resolveSymbol = vi.fn().mockResolvedValue({
  status: 'resolved', symbol: 'NVDA', moomoo: 'NVDA', yahoo: 'NVDA',
  name: 'NVIDIA Corporation', exchange: 'NASDAQ', quoteType: 'Equity',
})
vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: (...a: unknown[]) => resolveSymbol(...a),
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
  insertValues.mockReset()
  resolveSymbol.mockClear()
  updateSet.mockReset()
  updateWhere.mockReset()
  selectLimit.mockReset()

  insertValues.mockReturnValue({ returning: insertReturning })
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

  it('returns 409 when a run is already in-flight for the same (user, symbol)', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'inflight-run-7' }])
    const event = makeEvent({ symbol: 'NVDA' })
    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 409,
      data: { run_id: 'inflight-run-7' },
    })
    // No new row should have been inserted when a run is already in-flight.
    expect(insertReturning).not.toHaveBeenCalled()
  })

  it('starts research runs for exact Yahoo-only equities that have no moomoo code', async () => {
    resolveSymbol.mockResolvedValueOnce({
      status: 'resolved',
      symbol: '0097.KL',
      moomoo: null,
      yahoo: '0097.KL',
      name: 'ViTrox Corporation Berhad',
      exchange: 'Kuala Lumpur',
      quoteType: 'Equity',
    })
    const event = makeEvent({ symbol: '0097.KL' })

    await handler(event)

    expect(insertReturning).toHaveBeenCalledTimes(1)
    const values = insertValues.mock.calls[0]?.[0]
    expect(values).toMatchObject({
      symbol: '0097.KL',
      config: expect.objectContaining({ company_name: 'ViTrox Corporation Berhad' }),
    })
    const upstreamBody = JSON.parse(
      ((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { body: string }).body,
    )
    expect(upstreamBody).toMatchObject({
      symbol: '0097.KL',
      company_name: 'ViTrox Corporation Berhad',
    })
  })
})
