import { createError } from 'h3'
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { orderProposals } from '../../db/schema'
import type { Account, Order, PlaceOrderResult } from '../llm/http'
import {
  orderRuleProblem,
  sessionSchema,
  orderTypeSchema,
  pickOrderFields,
  timeInForceSchema,
  trailTypeSchema,
  trdEnvSchema,
  type OrderSettings,
} from './order-types'
import { STUCK_AFTER_MS } from './order-types'
import type { PaperOrderEntry } from './paper-orders'
import { paperAccountFor } from './open-orders'
import { upstreamError } from '../utils/upstream-error'

// The approval queue. An order proposed by a debate, the chat, the order
// ticket or an algo strategy waits here until the owner approves it on the
// Orders page; only then is it sent to the api. The logic takes its store and
// api client as arguments so tests run it against in-memory fakes; the
// Drizzle store at the bottom is the one the routes use.

export const PROPOSAL_SOURCES = ['debate', 'chat', 'ticket', 'algo'] as const
export type ProposalSource = typeof PROPOSAL_SOURCES[number]
export const PROPOSAL_STATUSES = ['pending', 'submitting', 'submitted', 'rejected', 'expired', 'failed'] as const
export type ProposalStatus = typeof PROPOSAL_STATUSES[number]

export interface Proposal {
  id: string
  createdAt: string | Date
  expiresAt: string | Date
  source: ProposalSource
  decisionId: string | null
  algoStrategyId: string | null
  accId: string | null
  trdEnv: 'SIMULATE' | 'REAL'
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  orderType: OrderSettings['order_type'] & string
  price: number | null
  triggerPrice: number | null
  trailType: 'RATIO' | 'AMOUNT' | null
  trailValue: number | null
  trailSpread: number | null
  timeInForce: 'DAY' | 'GTC'
  session: 'RTH' | 'ETH' | 'OVERNIGHT' | 'ALL'
  rationale: string | null
  status: ProposalStatus
  moomooOrderId: string | null
  error: string | null
  decidedAt: string | Date | null
  /** When approval moved it to submitting; null otherwise. */
  claimedAt: string | Date | null
}

// --- Input shapes ----------------------------------------------------------

const optionalPositive = z.number().positive().nullish()

/** The order fields a pending proposal may change. Account, symbol and side stay fixed. */
export const proposalEditSchema = z.object({
  qty: z.number().int().min(1).optional(),
  orderType: orderTypeSchema.optional(),
  price: optionalPositive,
  triggerPrice: optionalPositive,
  trailType: trailTypeSchema.nullish(),
  trailValue: optionalPositive,
  trailSpread: z.number().min(0).nullish(),
  timeInForce: timeInForceSchema.optional(),
  session: sessionSchema.optional(),
}).strict()
export type ProposalEdit = z.infer<typeof proposalEditSchema>

export const proposalInputSchema = z.object({
  source: z.enum(PROPOSAL_SOURCES),
  decisionId: z.string().uuid().nullish(),
  algoStrategyId: z.string().uuid().nullish(),
  accId: z.string().min(1).nullable(),
  trdEnv: trdEnvSchema,
  symbol: z.string().min(1).max(32),
  side: z.enum(['BUY', 'SELL']),
  qty: z.number().int().min(1),
  orderType: orderTypeSchema.optional(),
  price: optionalPositive,
  triggerPrice: optionalPositive,
  trailType: trailTypeSchema.nullish(),
  trailValue: optionalPositive,
  trailSpread: z.number().min(0).nullish(),
  timeInForce: timeInForceSchema.optional(),
  session: sessionSchema.optional(),
  rationale: z.string().max(4000).nullish(),
})
export type ProposalInput = z.infer<typeof proposalInputSchema>

export type ProposalInsert = Omit<Proposal, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'moomooOrderId' | 'error' | 'decidedAt' | 'claimedAt'>
export type ProposalPatch = Partial<Omit<Proposal, 'id' | 'createdAt'>>

export interface ProposalStore {
  insert(values: ProposalInsert): Promise<Proposal>
  get(id: string): Promise<Proposal | null>
  /** pending and unexpired → submitting, in one step; null when it was not both. */
  claim(id: string): Promise<Proposal | null>
  finish(id: string, patch: ProposalPatch): Promise<Proposal | null>
  /** Applies the patch only while the row is pending; null otherwise. */
  updatePending(id: string, patch: ProposalPatch): Promise<Proposal | null>
}

export interface OrderPlacer {
  placeOrder(args: OrderSettings & { remark?: string; trd_env?: 'SIMULATE' | 'REAL'; acc_id?: string }): Promise<PlaceOrderResult>
  listOrders(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL'; active_only?: boolean }): Promise<Order[]>
  listAccounts(): Promise<Account[]>
  listHistoryOrders(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Order[]>
}

// --- Rules -----------------------------------------------------------------

export function proposalOrder(p: Pick<Proposal, 'symbol' | 'side' | 'qty' | 'orderType' | 'price' | 'triggerPrice' | 'trailType' | 'trailValue' | 'trailSpread' | 'timeInForce' | 'session'>): OrderSettings {
  return pickOrderFields({
    code: p.symbol,
    side: p.side,
    qty: p.qty,
    order_type: p.orderType,
    price: p.price ?? undefined,
    trigger_price: p.triggerPrice ?? undefined,
    trail_type: p.trailType ?? undefined,
    trail_value: p.trailValue ?? undefined,
    trail_spread: p.trailSpread ?? undefined,
    time_in_force: p.timeInForce,
    session: p.session,
  })
}

function unprocessable(message: string) {
  return createError({ statusCode: 422, statusMessage: message, data: { detail: message } })
}

function problemOf(p: Parameters<typeof proposalOrder>[0] & { trdEnv: 'SIMULATE' | 'REAL'; accId: string | null }): string | null {
  if (p.trdEnv === 'REAL' && !p.accId) return 'a live proposal needs an account'
  return orderRuleProblem({ ...proposalOrder(p), trd_env: p.trdEnv })
}

export const remarkFor = (id: string) => `q:${id}`

const uuidSchema = z.string().uuid()
export function parseProposalId(raw: string | undefined): string {
  const parsed = uuidSchema.safeParse(raw)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'not a proposal id' })
  return parsed.data
}

// --- Operations ------------------------------------------------------------

export async function createProposal(input: ProposalInput, store: ProposalStore): Promise<Proposal> {
  const values: ProposalInsert = {
    source: input.source,
    decisionId: input.decisionId ?? null,
    algoStrategyId: input.algoStrategyId ?? null,
    accId: input.accId,
    trdEnv: input.trdEnv,
    symbol: input.symbol.trim().toUpperCase(),
    side: input.side,
    qty: input.qty,
    orderType: input.orderType ?? 'NORMAL',
    price: input.price ?? null,
    triggerPrice: input.triggerPrice ?? null,
    trailType: input.trailType ?? null,
    trailValue: input.trailValue ?? null,
    trailSpread: input.trailSpread ?? null,
    timeInForce: input.timeInForce ?? 'DAY',
    session: input.session ?? 'RTH',
    rationale: input.rationale ?? null,
  }
  const problem = problemOf(values)
  if (problem) throw unprocessable(problem)
  return store.insert(values)
}

export async function editProposal(id: string, edit: ProposalEdit, store: ProposalStore): Promise<Proposal> {
  const current = await store.get(id)
  if (!current) throw createError({ statusCode: 404, statusMessage: 'proposal not found' })
  if (current.status !== 'pending') throw createError({ statusCode: 409, statusMessage: `this proposal is ${current.status}, not pending` })
  const patch: ProposalPatch = { error: null }
  for (const [k, v] of Object.entries(edit) as [keyof ProposalEdit, ProposalEdit[keyof ProposalEdit]][]) {
    if (v !== undefined) Object.assign(patch, { [k]: v })
  }
  const problem = problemOf({ ...current, ...patch })
  if (problem) throw unprocessable(problem)
  const updated = await store.updatePending(id, patch)
  if (!updated) throw createError({ statusCode: 409, statusMessage: 'this proposal left the queue while you edited it' })
  return updated
}

export async function rejectProposal(id: string, store: ProposalStore): Promise<Proposal> {
  const updated = await store.updatePending(id, { status: 'rejected', decidedAt: new Date() })
  if (updated) return updated
  const current = await store.get(id)
  if (!current) throw createError({ statusCode: 404, statusMessage: 'proposal not found' })
  throw createError({ statusCode: 409, statusMessage: `this proposal is ${current.status}, not pending` })
}

interface FetchLikeError { status?: number; statusCode?: number; data?: { detail?: unknown }; message?: string }

function errorStatus(e: unknown): number | undefined {
  const err = (typeof e === 'object' && e !== null ? e : {}) as FetchLikeError
  return err.status ?? err.statusCode
}

function errorDetail(e: unknown): string {
  const err = (typeof e === 'object' && e !== null ? e : {}) as FetchLikeError
  if (typeof err.data?.detail === 'string' && err.data.detail) return err.data.detail
  return err.message || 'the api did not answer'
}

export interface ApproveDeps {
  store: ProposalStore
  client: OrderPlacer
  /** Writes the paper ledger row; best effort, never throws. */
  recordPaper?: (entry: PaperOrderEntry) => Promise<boolean>
}

/**
 * Sends a pending proposal to the api, once. The claim moves it to
 * `submitting` in one conditional write, so a second click finds nothing to
 * claim. A refusal (4xx) puts it back in the queue with the reason. A lost
 * reply (timeout, 5xx) is checked against today's orders by remark before
 * anything is decided, so it never turns into a second order.
 */
export async function approveProposal(id: string, deps: ApproveDeps): Promise<Proposal> {
  const { store, client } = deps
  const claimed = await store.claim(id)
  if (!claimed) {
    const current = await store.get(id)
    if (!current) throw createError({ statusCode: 404, statusMessage: 'proposal not found' })
    if (current.status === 'pending') {
      await store.updatePending(id, { status: 'expired', decidedAt: new Date() })
      throw createError({ statusCode: 409, statusMessage: 'this proposal expired; create a new one' })
    }
    throw createError({ statusCode: 409, statusMessage: `this proposal is already ${current.status}` })
  }

  const backToQueue = async (statusCode: number, message: string) => {
    await store.finish(id, { status: 'pending', error: message, claimedAt: null })
    return createError({ statusCode, statusMessage: message.replace(/\s+/g, ' ').slice(0, 200), data: { detail: message } })
  }

  const problem = problemOf(claimed)
  if (problem) throw await backToQueue(422, problem)

  let accId = claimed.accId
  if (!accId) {
    try {
      accId = paperAccountFor(await client.listAccounts(), claimed.symbol)?.acc_id ?? null
    } catch (e) {
      throw await backToQueue(502, `could not list accounts: ${errorDetail(e)}`)
    }
    if (!accId) throw await backToQueue(422, 'no paper account on this OpenD')
  }

  const remark = remarkFor(id)
  const order = proposalOrder(claimed)
  const submitted = async (orderId: string, status: string | null) => {
    const row = await store.finish(id, { status: 'submitted', moomooOrderId: orderId, accId, error: null, decidedAt: new Date() })
    if (claimed.trdEnv === 'SIMULATE' && deps.recordPaper) {
      await deps.recordPaper({
        source: claimed.source === 'debate' ? 'agent_decision' : claimed.source,
        decisionId: claimed.decisionId,
        moomooOrderId: orderId,
        accId,
        symbol: claimed.symbol,
        side: claimed.side,
        qty: claimed.qty,
        price: claimed.price,
        orderType: claimed.orderType,
        trdEnv: 'SIMULATE',
        status,
        raw: { proposal_id: id },
      })
    }
    return row ?? { ...claimed, status: 'submitted' as const, moomooOrderId: orderId, accId }
  }

  try {
    const res = await client.placeOrder({ ...order, remark, trd_env: claimed.trdEnv, acc_id: accId })
    return await submitted(res.order_id, res.status)
  } catch (e) {
    const status = errorStatus(e)
    if (status !== undefined && status >= 400 && status < 500) throw await backToQueue(status, errorDetail(e))

    // No answer, or the api failed after sending: the order may exist.
    let found: Order | undefined
    try {
      found = (await client.listOrders({ acc_id: accId, trd_env: claimed.trdEnv })).find(o => o.remark === remark)
    } catch {
      found = undefined
    }
    if (found) return await submitted(found.order_id, found.status)
    const message = `${errorDetail(e)}. No order with this proposal's remark was found, but one may still appear: check Active before retrying.`
    await store.finish(id, { status: 'failed', accId, error: message, decidedAt: new Date() })
    throw createError({ statusCode: 502, statusMessage: message.replace(/\s+/g, ' ').slice(0, 200), data: { detail: message } })
  }
}

export { STUCK_AFTER_MS }

export interface ResolveDeps {
  store: ProposalStore
  client: OrderPlacer
  now?: Date
  /** Mark it failed even when moomoo cannot be checked. */
  force?: boolean
}

/**
 * Unsticks a proposal left in submitting (the web restarted mid-approval, say).
 * It looks for the order by its remark in today's orders and the order history:
 * found, the proposal is submitted; not found, it goes back to pending to
 * approve again. When moomoo can't be asked it stays submitting, unless forced,
 * and then it is marked failed, never pending, since the order may exist.
 */
export async function resolveSubmitting(id: string, deps: ResolveDeps): Promise<Proposal> {
  const { store, client } = deps
  const now = deps.now ?? new Date()
  const current = await store.get(id)
  if (!current) throw createError({ statusCode: 404, statusMessage: 'proposal not found' })
  if (current.status !== 'submitting') {
    throw createError({ statusCode: 409, statusMessage: `this proposal is ${current.status}, not submitting` })
  }
  if (current.claimedAt && now.getTime() - new Date(current.claimedAt).getTime() < STUCK_AFTER_MS) {
    throw createError({ statusCode: 409, statusMessage: 'this proposal is still being placed; try again in a few minutes' })
  }

  const remark = remarkFor(id)
  let accId = current.accId
  let found: Order | undefined
  let lookupError: string | null = null
  try {
    if (!accId) accId = paperAccountFor(await client.listAccounts(), current.symbol)?.acc_id ?? null
    if (!accId) throw new Error('no paper account on this OpenD')
    const args = { acc_id: accId, trd_env: current.trdEnv }
    found = (await client.listOrders(args)).find(o => o.remark === remark)
      ?? (await client.listHistoryOrders(args)).find(o => o.remark === remark)
  } catch (e) {
    lookupError = errorDetail(e)
  }

  if (found) {
    const row = await store.finish(id, { status: 'submitted', moomooOrderId: found.order_id, accId, error: null, decidedAt: now })
    return row ?? { ...current, status: 'submitted', moomooOrderId: found.order_id, accId }
  }
  if (lookupError === null) {
    const error = 'It was stuck placing. No order carries its remark on moomoo, so it is back in the queue.'
    const row = await store.finish(id, { status: 'pending', error, claimedAt: null })
    return row ?? { ...current, status: 'pending', error, claimedAt: null }
  }
  if (!deps.force) {
    throw createError({ statusCode: 502, statusMessage: `could not check moomoo for its order: ${lookupError}`.slice(0, 200), data: { detail: lookupError } })
  }
  const error = `Marked failed by you without checking moomoo (${lookupError}). The order may still exist: check Active before queueing it again.`
  const row = await store.finish(id, { status: 'failed', error, decidedAt: now })
  return row ?? { ...current, status: 'failed', error }
}

/** The order ticket's "Place now": the same order a proposal would hold, sent straight away. */
export const ticketOrderSchema = proposalInputSchema
  .omit({ source: true, decisionId: true, algoStrategyId: true, rationale: true })
  .extend({ accId: z.string().min(1) })
export type TicketOrder = z.infer<typeof ticketOrderSchema>

export async function placeNow(
  input: TicketOrder,
  client: Pick<OrderPlacer, 'placeOrder'>,
  recordPaper?: (entry: PaperOrderEntry) => Promise<boolean>,
): Promise<PlaceOrderResult> {
  const fields = {
    symbol: input.symbol.trim().toUpperCase(),
    side: input.side,
    qty: input.qty,
    orderType: input.orderType ?? 'NORMAL',
    price: input.price ?? null,
    triggerPrice: input.triggerPrice ?? null,
    trailType: input.trailType ?? null,
    trailValue: input.trailValue ?? null,
    trailSpread: input.trailSpread ?? null,
    timeInForce: input.timeInForce ?? 'DAY',
    session: input.session ?? 'RTH',
  }
  const problem = problemOf({ ...fields, trdEnv: input.trdEnv, accId: input.accId })
  if (problem) throw unprocessable(problem)
  const order = proposalOrder(fields)
  let res: PlaceOrderResult
  try {
    res = await client.placeOrder({ ...order, trd_env: input.trdEnv, acc_id: input.accId })
  } catch (e) {
    throw upstreamError(e)
  }
  if (input.trdEnv === 'SIMULATE' && recordPaper) {
    await recordPaper({
      source: 'ticket',
      moomooOrderId: res.order_id,
      accId: res.acc_id,
      symbol: fields.symbol,
      side: fields.side,
      qty: fields.qty,
      price: order.price ?? null,
      orderType: fields.orderType,
      trdEnv: 'SIMULATE',
      status: res.status,
    })
  }
  return res
}

// --- Drizzle store ---------------------------------------------------------

type Row = typeof orderProposals.$inferSelect

const num = (v: string | null): number | null => (v == null ? null : Number(v))
const dec = (v: number | null | undefined): string | null | undefined => (v === undefined ? undefined : v === null ? null : String(v))

export function rowToProposal(r: Row): Proposal {
  return {
    id: r.id,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    source: r.source as ProposalSource,
    decisionId: r.decisionId,
    algoStrategyId: r.algoStrategyId,
    accId: r.accId,
    trdEnv: r.trdEnv as Proposal['trdEnv'],
    symbol: r.symbol,
    side: r.side as Proposal['side'],
    qty: r.qty,
    orderType: r.orderType as Proposal['orderType'],
    price: num(r.price),
    triggerPrice: num(r.triggerPrice),
    trailType: r.trailType as Proposal['trailType'],
    trailValue: num(r.trailValue),
    trailSpread: num(r.trailSpread),
    timeInForce: r.timeInForce as Proposal['timeInForce'],
    session: r.session as Proposal['session'],
    rationale: r.rationale,
    status: r.status as ProposalStatus,
    moomooOrderId: r.moomooOrderId,
    error: r.error,
    decidedAt: r.decidedAt,
    claimedAt: r.claimedAt,
  }
}

function toRowPatch(p: ProposalPatch): Partial<typeof orderProposals.$inferInsert> {
  const { price, triggerPrice, trailValue, trailSpread, expiresAt, decidedAt, claimedAt, ...rest } = p
  const out: Partial<typeof orderProposals.$inferInsert> = { ...rest }
  if (price !== undefined) out.price = dec(price)
  if (triggerPrice !== undefined) out.triggerPrice = dec(triggerPrice)
  if (trailValue !== undefined) out.trailValue = dec(trailValue)
  if (trailSpread !== undefined) out.trailSpread = dec(trailSpread)
  if (expiresAt !== undefined) out.expiresAt = new Date(expiresAt)
  if (decidedAt !== undefined) out.decidedAt = decidedAt === null ? null : new Date(decidedAt)
  if (claimedAt !== undefined) out.claimedAt = claimedAt === null ? null : new Date(claimedAt)
  return out
}

export function drizzleProposalStore(): ProposalStore {
  const db = getDb()
  return {
    async insert(values) {
      const rows = await db.insert(orderProposals).values({
        ...values,
        price: dec(values.price),
        triggerPrice: dec(values.triggerPrice),
        trailValue: dec(values.trailValue),
        trailSpread: dec(values.trailSpread),
      }).returning()
      const row = rows[0]
      if (!row) throw new Error('proposal insert returned no row')
      return rowToProposal(row)
    },
    async get(id) {
      const rows = await db.select().from(orderProposals).where(eq(orderProposals.id, id)).limit(1)
      return rows[0] ? rowToProposal(rows[0]) : null
    },
    async claim(id) {
      const rows = await db.update(orderProposals)
        .set({ status: 'submitting', claimedAt: sql`now()` })
        .where(and(eq(orderProposals.id, id), eq(orderProposals.status, 'pending'), gt(orderProposals.expiresAt, sql`now()`)))
        .returning()
      return rows[0] ? rowToProposal(rows[0]) : null
    },
    async finish(id, patch) {
      const rows = await db.update(orderProposals).set(toRowPatch(patch)).where(eq(orderProposals.id, id)).returning()
      return rows[0] ? rowToProposal(rows[0]) : null
    },
    async updatePending(id, patch) {
      const rows = await db.update(orderProposals).set(toRowPatch(patch))
        .where(and(eq(orderProposals.id, id), eq(orderProposals.status, 'pending')))
        .returning()
      return rows[0] ? rowToProposal(rows[0]) : null
    },
  }
}

/** Pending rows past their expiry turn expired; then pending ones plus the last week's decided ones. */
export async function listProposals(): Promise<{ proposals: Proposal[]; pendingCount: number }> {
  const db = getDb()
  await db.update(orderProposals)
    .set({ status: 'expired', decidedAt: sql`now()` })
    .where(and(eq(orderProposals.status, 'pending'), lte(orderProposals.expiresAt, sql`now()`)))
  const rows = await db.select().from(orderProposals)
    .where(or(
      inArray(orderProposals.status, ['pending', 'submitting']),
      gt(orderProposals.createdAt, sql`now() - interval '7 days'`),
    ))
    .orderBy(desc(orderProposals.createdAt))
    .limit(200)
  const proposals = rows.map(rowToProposal)
  return { proposals, pendingCount: proposals.filter(p => p.status === 'pending').length }
}
