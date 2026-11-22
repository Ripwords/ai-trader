import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoldingPosition, HoldingSummary } from '../../server/lib/holdings'

const holding = vi.fn<(symbol: string) => Promise<Partial<HoldingSummary>>>()
const planning = vi.fn<() => Promise<{ monthly_contribution: number }>>()
const memories = vi.fn<(userId: string) => Promise<{ content: string }[]>>()

vi.mock('../../server/lib/holdings', () => ({ getHoldingForSymbol: holding }))
vi.mock('../../server/lib/planning-settings', () => ({ getPlanningSettings: planning }))
vi.mock('../../server/lib/chat-memory', () => ({ listMemories: memories }))

const { buildOwnerContext } = await import('../../server/lib/agents/owner-context')

function position(over: Partial<HoldingPosition>): HoldingPosition {
  return {
    source: 'moomoo_live',
    symbol: 'US.NVDA',
    quantity: 10,
    avg_cost: 100,
    current_price: 120,
    market_value: 1200,
    unrealized_pnl_pct: 20,
    account_label: 'Moomoo Live',
    currency: 'USD',
    ...over,
  }
}

const TRACKER = position({ source: 'ghostfolio', quantity: 10.01, market_value: 5300, unrealized_pnl_pct: 18, currency: 'MYR' })

beforeEach(() => {
  holding.mockReset()
  planning.mockReset().mockResolvedValue({ monthly_contribution: 3000 })
  memories.mockReset().mockResolvedValue([{ content: 'Tech concentration is deliberate.' }])
})

describe('buildOwnerContext', () => {
  it('describes a broker position in the broker currency with the tracker weight', async () => {
    holding.mockResolvedValue({
      answer_source: 'moomoo_live',
      owned_quantity: 10,
      owned_market_value: 1200,
      positions: [TRACKER, position({}), position({ source: 'moomoo_paper', quantity: 500 })],
      allocation_pct: 4.2,
      net_worth_total: 520000,
      net_worth_currency: 'MYR',
      ghostfolio_status: 'ok',
    })

    expect(await buildOwnerContext('US.NVDA', 'user-1')).toEqual({
      base_currency: 'MYR',
      position: { status: 'held', quantity: 10, market_value: 1200, currency: 'USD', weight_pct: 4.2, unrealized_pnl_pct: 20 },
      investable_total: 520000,
      monthly_contribution: 3000,
      notes: ['Tech concentration is deliberate.'],
    })
    expect(holding).toHaveBeenCalledWith('US.NVDA')
    expect(memories).toHaveBeenCalledWith('user-1')
  })

  it('describes a tracker-only position in the base currency', async () => {
    holding.mockResolvedValue({
      answer_source: 'ghostfolio_tracker',
      owned_quantity: 10.01,
      owned_market_value: 5300,
      positions: [TRACKER],
      allocation_pct: 1.02,
      net_worth_total: 520000,
      net_worth_currency: 'MYR',
      ghostfolio_status: 'ok',
    })

    const owner = await buildOwnerContext('US.NVDA', 'user-1')

    expect(owner.position).toEqual({
      status: 'held', quantity: 10.01, market_value: 5300, currency: 'MYR', weight_pct: 1.02, unrealized_pnl_pct: 18,
    })
  })

  it('weights the gain across accounts and drops a currency the accounts disagree on', async () => {
    holding.mockResolvedValue({
      answer_source: 'moomoo_live',
      owned_quantity: 20,
      owned_market_value: 4000,
      positions: [
        position({ market_value: 1000, unrealized_pnl_pct: 40 }),
        position({ market_value: 3000, unrealized_pnl_pct: 0, currency: 'HKD' }),
      ],
      allocation_pct: null,
      net_worth_total: null,
      net_worth_currency: null,
      ghostfolio_status: 'failing',
    })

    const owner = await buildOwnerContext('US.NVDA', 'user-1')

    expect(owner.position).toEqual({
      status: 'held', quantity: 20, market_value: 4000, currency: null, weight_pct: null, unrealized_pnl_pct: 10,
    })
    expect(owner.base_currency).toBeNull()
    expect(owner.investable_total).toBeNull()
  })

  it('says not held only when the tracker could be read', async () => {
    const none = { answer_source: 'none' as const, owned_quantity: 0, owned_market_value: 0, positions: [], allocation_pct: null }
    holding.mockResolvedValueOnce({ ...none, net_worth_total: 520000, net_worth_currency: 'MYR', ghostfolio_status: 'ok' })
    holding.mockResolvedValueOnce({ ...none, net_worth_total: null, net_worth_currency: null, ghostfolio_status: 'failing' })

    expect((await buildOwnerContext('US.NVDA', 'user-1')).position).toEqual({ status: 'not_held' })
    expect((await buildOwnerContext('US.NVDA', 'user-1')).position).toEqual({ status: 'unknown' })
  })

  it('does not send a size the api would reject', async () => {
    holding.mockResolvedValue({
      answer_source: 'moomoo_live',
      owned_quantity: -5,
      owned_market_value: -600,
      positions: [position({ quantity: -5, market_value: -600 })],
      allocation_pct: null,
      net_worth_total: null,
      net_worth_currency: null,
      ghostfolio_status: 'ok',
    })

    expect((await buildOwnerContext('US.NVDA', 'user-1')).position).toEqual({ status: 'unknown' })
  })

  it('still starts a run when every source fails', async () => {
    holding.mockRejectedValue(new Error('accounts down'))
    planning.mockRejectedValue(new Error('db down'))
    memories.mockRejectedValue(new Error('db down'))

    expect(await buildOwnerContext('US.NVDA', 'user-1')).toEqual({
      base_currency: null,
      position: { status: 'unknown' },
      investable_total: null,
      monthly_contribution: null,
      notes: [],
    })
  })

  it('leaves out a monthly contribution that was never set', async () => {
    holding.mockRejectedValue(new Error('accounts down'))
    planning.mockResolvedValue({ monthly_contribution: 0 })

    expect((await buildOwnerContext('US.NVDA', 'user-1')).monthly_contribution).toBeNull()
  })
})
