import type { TradingSettings } from '../../types/trading'
import type { ProposalInput } from './order-proposals'
import { paperAccountFor } from './open-orders'

// When Settings → Trading → Debate proposals is on, a debate that rates a
// stock buy or sell leaves a matching order in the approval queue. Nothing is
// placed: the owner edits and approves it on the Orders page.

export interface DebateDecision {
  decisionId: string
  symbol: string
  rating: string
  confidence: number | null
  rationale: string
}

export interface DebateProposalDeps {
  getSettings(): Promise<TradingSettings>
  getLastPrice(symbol: string): Promise<number | null>
  /** Shares held in the target account; accId null means the first paper account. */
  getHeldQty(args: { accId: string | null; trdEnv: 'SIMULATE' | 'REAL'; symbol: string }): Promise<number>
  create(input: ProposalInput): Promise<unknown>
}

export type DebateProposalResult = { created: true } | { created: false; reason: string }

const BUY = new Set(['buy', 'strong-buy'])
const SELL_ALL = new Set(['sell'])
const SELL_HALF = new Set(['reduce'])

export async function proposeFromDecision(d: DebateDecision, deps: DebateProposalDeps): Promise<DebateProposalResult> {
  const settings = await deps.getSettings()
  if (!settings.debateProposals) return { created: false, reason: 'off' }
  const rating = d.rating.toLowerCase()
  const side = BUY.has(rating) ? 'BUY' : SELL_ALL.has(rating) || SELL_HALF.has(rating) ? 'SELL' : null
  if (!side) return { created: false, reason: 'not a buy or sell' }
  if (!/^[A-Z]+\./i.test(d.symbol)) return { created: false, reason: 'no market prefix' }

  const price = await deps.getLastPrice(d.symbol)
  if (price == null || !(price > 0)) return { created: false, reason: 'no price' }

  let qty: number
  if (side === 'BUY') {
    qty = Math.floor(settings.notional / price)
    if (qty < 1) return { created: false, reason: 'notional below one share' }
  } else {
    const held = await deps.getHeldQty({ accId: settings.accId, trdEnv: settings.trdEnv, symbol: d.symbol })
    if (held < 1) return { created: false, reason: 'no position to sell' }
    qty = SELL_HALF.has(rating) ? Math.max(1, Math.floor(held / 2)) : held
  }

  const confidence = d.confidence == null ? '' : ` (${d.confidence}% confidence)`
  await deps.create({
    source: 'debate',
    decisionId: d.decisionId,
    accId: settings.accId,
    trdEnv: settings.trdEnv,
    symbol: d.symbol,
    side,
    qty,
    orderType: 'NORMAL',
    price,
    timeInForce: 'DAY',
    session: 'RTH',
    rationale: `Debate rated ${rating.toUpperCase()}${confidence}. ${d.rationale}`.slice(0, 4000),
  })
  return { created: true }
}

/** The deps the agents tee uses: saved settings, the api for price and position, the Drizzle queue. */
export async function liveDebateDeps(): Promise<DebateProposalDeps> {
  const [{ getTradingSettings }, { getApiClient }, { createProposal, drizzleProposalStore }] = await Promise.all([
    import('./trading-settings'),
    import('../llm/http'),
    import('./order-proposals'),
  ])
  const client = getApiClient()
  return {
    getSettings: getTradingSettings,
    getLastPrice: async (symbol) => {
      const snap = await client.getSnapshot({ code: symbol })
      return Number.isFinite(snap.lastPrice) ? snap.lastPrice : null
    },
    getHeldQty: async ({ accId, trdEnv, symbol }) => {
      const acc = accId ?? paperAccountFor(await client.listAccounts(), symbol)?.acc_id
      if (!acc) return 0
      const pf = await client.getPortfolio({ acc_id: acc, trd_env: trdEnv })
      return pf.positions.find(p => p.code === symbol)?.qty ?? 0
    },
    create: input => createProposal(input, drizzleProposalStore()),
  }
}
