import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  overrides: {} as Record<string, string>,
  writes: [] as Array<[string, string]>,
  deletes: [] as string[],
}))
vi.mock('../../server/lib/prompts/store', () => ({
  readPromptOverrides: async () => ({ ...store.overrides }),
  writePromptOverride: async (id: string, text: string) => {
    store.writes.push([id, text])
    store.overrides[id] = text
  },
  deletePromptOverride: async (id: string) => {
    store.deletes.push(id)
    delete store.overrides[id]
  },
}))

const agents = vi.hoisted(() => ({
  defaults: {
    market_analyst: { text: 'Analyse {ticker} on {current_date}.', placeholders: ['current_date', 'ticker'] },
    risk_manager: { text: 'Decide. FINAL TRANSACTION PROPOSAL {history}', placeholders: ['history'] },
  } as Record<string, { text: string; placeholders: string[] }>,
  down: false,
}))
vi.mock('../../server/lib/prompts/agents-defaults', () => ({
  fetchAgentsDefaults: async () => {
    if (agents.down) throw new Error('connect ECONNREFUSED')
    return agents.defaults
  },
}))
vi.mock('../../server/api/internal/_guard', () => ({
  requireInternalBearer: (e: { _authorized?: boolean }) => {
    if (!e._authorized) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
  },
}))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return {
    ...actual,
    readBody: (e: { _body: unknown }) => Promise.resolve(e._body),
    getRouterParam: (e: { _params: Record<string, string> }, k: string) => e._params[k],
  }
})

type Handler = (e: H3Event) => Promise<unknown>
const list = (await import('../../server/api/settings/prompts/index.get')).default as Handler
const put = (await import('../../server/api/settings/prompts/[id].put')).default as Handler
const del = (await import('../../server/api/settings/prompts/[id].delete')).default as Handler
const internal = (await import('../../server/api/internal/prompts.get')).default as Handler
const { webDefault } = await import('../../server/lib/prompts/registry')

const event = (opts: { body?: unknown; id?: string; authorized?: boolean } = {}) =>
  ({ _body: opts.body, _params: opts.id ? { id: opts.id } : {}, _authorized: opts.authorized, context: {} }) as unknown as H3Event

async function rejection(p: Promise<unknown>): Promise<{ statusCode?: number; statusMessage?: string }> {
  try {
    await p
  } catch (e) {
    return e as { statusCode?: number; statusMessage?: string }
  }
  throw new Error('expected a rejection')
}

interface ListedPrompt {
  id: string
  engine: string
  default: string | null
  override: string | null
  modified: boolean
  placeholders: string[]
}

beforeEach(() => {
  store.overrides = {}
  store.writes = []
  store.deletes = []
  agents.down = false
})

describe('GET /api/settings/prompts', () => {
  it('merges web defaults, agents defaults from the api, and stored overrides', async () => {
    store.overrides = { 'chat.system': 'custom' }
    const res = await list(event()) as { prompts: ListedPrompt[]; agentsError: string | null }
    const chat = res.prompts.find(p => p.id === 'chat.system')!
    expect(chat).toMatchObject({ engine: 'web', default: webDefault('chat.system'), override: 'custom', modified: true })
    const market = res.prompts.find(p => p.id === 'agents.market_analyst')!
    expect(market).toMatchObject({ engine: 'agents', default: 'Analyse {ticker} on {current_date}.', override: null, modified: false })
    expect(market.placeholders).toEqual(['current_date', 'ticker'])
    expect(res.agentsError).toBeNull()
  })

  it('still lists everything when the api is down, with the agents defaults missing', async () => {
    agents.down = true
    const res = await list(event()) as { prompts: ListedPrompt[]; agentsError: string | null }
    expect(res.agentsError).toMatch(/agents service/i)
    expect(res.prompts.find(p => p.id === 'agents.market_analyst')!.default).toBeNull()
    expect(res.prompts.find(p => p.id === 'chat.system')!.default).toBe(webDefault('chat.system'))
  })
})

describe('PUT /api/settings/prompts/:id', () => {
  it('saves an override and returns contract warnings', async () => {
    const res = await put(event({ id: 'agents.risk_manager', body: { text: 'Decide {history}.' } })) as { modified: boolean; warnings: string[] }
    expect(res.modified).toBe(true)
    expect(res.warnings[0]).toContain('FINAL TRANSACTION PROPOSAL')
    expect(store.writes).toEqual([['agents.risk_manager', 'Decide {history}.']])
  })

  it('deletes the override when the text equals the default', async () => {
    store.overrides = { 'chat.moomoo_rules': 'old' }
    const res = await put(event({ id: 'chat.moomoo_rules', body: { text: webDefault('chat.moomoo_rules') } })) as { modified: boolean }
    expect(res.modified).toBe(false)
    expect(store.deletes).toEqual(['chat.moomoo_rules'])
    expect(store.writes).toEqual([])
  })

  it('rejects an unknown placeholder with a 400', async () => {
    const err = await rejection(put(event({ id: 'agents.market_analyst', body: { text: 'Analyse {symbol}.' } })))
    expect(err.statusCode).toBe(400)
    expect(err.statusMessage).toContain('{symbol}')
    expect(store.writes).toEqual([])
  })

  it('rejects an unknown id with a 404 and a missing body with a 400', async () => {
    expect((await rejection(put(event({ id: 'nope', body: { text: 'x' } })))).statusCode).toBe(404)
    expect((await rejection(put(event({ id: 'chat.system', body: {} })))).statusCode).toBe(400)
  })

  it('refuses to save an agents prompt it cannot validate because the api is down', async () => {
    agents.down = true
    expect((await rejection(put(event({ id: 'agents.market_analyst', body: { text: 'x {ticker}' } })))).statusCode).toBe(503)
  })
})

describe('DELETE /api/settings/prompts/:id', () => {
  it('removes the override', async () => {
    store.overrides = { 'chat.system': 'custom' }
    expect(await del(event({ id: 'chat.system' }))).toEqual({ ok: true })
    expect(store.deletes).toEqual(['chat.system'])
  })
})

describe('GET /api/internal/prompts', () => {
  it('requires the internal bearer', async () => {
    expect((await rejection(internal(event()))).statusCode).toBe(401)
  })

  it('returns only the agents overrides, keyed by the node prompt name', async () => {
    store.overrides = { 'chat.system': 'web only', 'agents.trader_system': 'trader override' }
    expect(await internal(event({ authorized: true }))).toEqual({ overrides: { trader_system: 'trader override' } })
  })
})
