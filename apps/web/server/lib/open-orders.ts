import type { Account, Order } from '../llm/http'

// Today's working orders across every account the Orders page can trade.
// The api decides which statuses are finished (`active_only`); an account it
// cannot read comes back as a failure, so the page warns rather than showing
// an empty table that looks like "no orders".

export interface AccountSummary {
  acc_id: string
  trd_env: 'SIMULATE' | 'REAL'
  label: string
  markets: string[]
}

export interface OpenOrdersFailure {
  acc_id: string
  trd_env: 'SIMULATE' | 'REAL'
  label: string
  message: string
}

export interface OpenOrders {
  orders: (Order & { acc_id: string; trd_env: 'SIMULATE' | 'REAL' })[]
  accounts: AccountSummary[]
  failures: OpenOrdersFailure[]
}

export interface OpenOrdersClient {
  listAccounts(): Promise<Account[]>
  listOrders(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL'; active_only?: boolean }): Promise<Order[]>
}

export function tradableAccounts(accounts: Account[]): Account[] {
  return accounts.filter(a => a.acc_role !== 'IPO')
}

/**
 * How the page names an account: environment, markets (when there are one or
 * two; a multi-market account would be a long list) and the card's last four
 * digits, which moomoo reports as "N/A" for paper accounts.
 */
export function accountLabel(a: Account): string {
  const parts = [a.trd_env === 'REAL' ? 'Live' : 'Paper']
  if (a.trdmarket_auth.length && a.trdmarket_auth.length <= 2) parts.push(a.trdmarket_auth.join('/'))
  const card = a.card_num && /\d{4}$/.test(a.card_num) ? a.card_num.slice(-4) : null
  if (card) parts.push(`··${card}`)
  return parts.join(' ')
}

/**
 * The paper account an order with no account goes to: the one that trades
 * the symbol's market (moomoo keeps a paper account per market), else the
 * first paper account.
 */
export function paperAccountFor<A extends { trd_env: string; trdmarket_auth?: string[]; markets?: string[] }>(
  accounts: A[],
  symbol: string,
): A | undefined {
  const paper = accounts.filter(a => a.trd_env === 'SIMULATE')
  const market = symbol.split('.')[0]?.toUpperCase() ?? ''
  return paper.find(a => (a.trdmarket_auth ?? a.markets ?? []).includes(market)) ?? paper[0]
}

export function summarizeAccount(a: Account): AccountSummary {
  return { acc_id: a.acc_id, trd_env: a.trd_env, label: accountLabel(a), markets: a.trdmarket_auth }
}

function messageOf(e: unknown): string {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { data?: { detail?: unknown }; message?: string }
  if (typeof err.data?.detail === 'string' && err.data.detail) return err.data.detail
  return err.message || 'could not load orders'
}

export async function loadOpenOrders(client: OpenOrdersClient): Promise<OpenOrders> {
  const accounts = tradableAccounts(await client.listAccounts())
  const results = await Promise.all(accounts.map(async (a) => {
    try {
      const orders = await client.listOrders({ acc_id: a.acc_id, trd_env: a.trd_env, active_only: true })
      return { orders: orders.map(o => ({ ...o, acc_id: a.acc_id, trd_env: a.trd_env })), failure: null }
    } catch (e) {
      return { orders: [], failure: { acc_id: a.acc_id, trd_env: a.trd_env, label: accountLabel(a), message: messageOf(e) } }
    }
  }))
  const orders = results.flatMap(r => r.orders).sort((x, y) => y.created_at.localeCompare(x.created_at))
  const failures = results.flatMap(r => (r.failure ? [r.failure] : []))
  return { orders, accounts: accounts.map(summarizeAccount), failures }
}
