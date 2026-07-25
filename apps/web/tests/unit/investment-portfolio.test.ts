import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The investments layer: Moomoo live only. These tests pin the three defects
 * that made the chat answer a portfolio question with a net-worth number —
 * wrong scope, wrong currency, and no day-change baseline.
 */

interface MockAccount {
  acc_id: string
  trd_env: 'REAL' | 'SIMULATE'
  acc_role: string | null
}

interface MockPosition {
  code: string
  qty: number
  cost_price: number
  current_price: number
  market_val: number
  pl_val: number
  pl_ratio: number
  currency: string | null
}

interface MockPortfolio {
  cash: number
  market_val: number
  total_assets: number
  positions: MockPosition[]
  currency: string | null
  cash_by_currency: Record<string, number>
}

function pos(over: Partial<MockPosition> & { code: string; qty: number }): MockPosition {
  return {
    cost_price: 0,
    current_price: 0,
    market_val: 0,
    pl_val: 0,
    pl_ratio: 0,
    currency: 'USD',
    ...over,
  }
}

function portfolio(over: Partial<MockPortfolio> = {}): MockPortfolio {
  return {
    cash: 0,
    market_val: 0,
    total_assets: 0,
    positions: [],
    currency: 'MYR',
    cash_by_currency: {},
    ...over,
  }
}

interface SetupArgs {
  accounts: MockAccount[]
  portfolios: Record<string, MockPortfolio | Error>
  snapshots?: Record<string, { prevClosePrice: number } | Error>
  fx?: Record<string, number | null>
}

async function setup(args: SetupArgs) {
  const getPortfolio = vi.fn(async ({ acc_id }: { acc_id: string; trd_env: string }) => {
    const p = args.portfolios[acc_id]
    if (p instanceof Error) throw p
    if (!p) throw new Error(`no portfolio fixture for ${acc_id}`)
    return p
  })
  const getSnapshot = vi.fn(async ({ code }: { code: string }) => {
    const s = args.snapshots?.[code]
    if (s instanceof Error) throw s
    if (!s) throw new Error(`no snapshot fixture for ${code}`)
    return { code, ...s }
  })
  const listAccounts = vi.fn(async () => args.accounts)

  vi.doMock('../../server/llm/http', () => ({
    getApiClient: () => ({ listAccounts, getPortfolio, getSnapshot }),
  }))
  vi.doMock('../../server/lib/yahoo', () => ({
    getFxRate: vi.fn(async (from: string, to: string) => {
      if (from === to) return 1
      return args.fx?.[`${from}${to}`] ?? null
    }),
  }))

  const { getInvestmentPortfolio } = await import('../../server/lib/investment-portfolio')
  const result = await getInvestmentPortfolio()
  return { result, listAccounts, getPortfolio, getSnapshot }
}

describe('investment portfolio (Moomoo live layer)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('uses only REAL non-IPO accounts — never paper, never IPO', async () => {
    const { result, getPortfolio } = await setup({
      accounts: [
        { acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' },
        { acc_id: 'ipo', trd_env: 'REAL', acc_role: 'IPO' },
        { acc_id: 'paper', trd_env: 'SIMULATE', acc_role: 'OWNER' },
      ],
      portfolios: {
        live: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100 })],
          cash_by_currency: { USD: 500 },
        }),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: { USDMYR: 4 },
    })

    expect(result.source).toBe('moomoo_live')
    expect(result.accounts).toEqual(['live'])
    const envs = getPortfolio.mock.calls.map(c => c[0].trd_env)
    expect(new Set(envs)).toEqual(new Set(['REAL']))
    const ids = getPortfolio.mock.calls.map(c => c[0].acc_id)
    expect(ids).toEqual(['live'])
  })

  it('computes day change against previous close', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [pos({
            code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100, pl_val: 200,
          })],
        }),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: { USDMYR: 4 },
    })

    const p = result.positions[0]!
    expect(p.prev_close).toBe(100)
    // 1100 market value vs 10 x 100 = 1000 at yesterday's close
    expect(p.day_change_value).toBeCloseTo(100, 6)
    expect(p.day_change_pct).toBeCloseTo(10, 6)
    // Since-cost P&L is carried alongside, not instead of.
    expect(p.cost_basis).toBeCloseTo(900, 6)
    expect(p.unrealized_pl_pct).toBeCloseTo(22.2222, 3)
  })

  it('blends the day-change percent across currencies using FX weights', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [
            pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100, currency: 'USD' }),
            pos({ code: 'HK.00700', qty: 100, cost_price: 280, current_price: 290, market_val: 29_000, currency: 'HKD' }),
          ],
        }),
      },
      snapshots: {
        'US.NVDA': { prevClosePrice: 100 },
        'HK.00700': { prevClosePrice: 300 },
      },
      fx: { USDMYR: 4, HKDMYR: 0.6 },
    })

    expect(result.reporting_currency).toBe('MYR')
    // Native buckets stay native — no cross-currency addition here.
    const usd = result.by_currency.find(b => b.currency === 'USD')!
    const hkd = result.by_currency.find(b => b.currency === 'HKD')!
    expect(usd.market_value).toBeCloseTo(1100, 6)
    expect(usd.day_change_value).toBeCloseTo(100, 6)
    expect(hkd.market_value).toBeCloseTo(29_000, 6)
    expect(hkd.day_change_value).toBeCloseTo(-1000, 6)

    // Converted: USD 1100*4 = 4400, HKD 29000*0.6 = 17400 → 21800
    expect(result.total_market_value_reporting).toBeCloseTo(21_800, 6)
    // Day change: +100*4 = +400, -1000*0.6 = -600 → -200
    expect(result.total_day_change_reporting).toBeCloseTo(-200, 6)
    // Yesterday's close in MYR = 21800 + 200 = 22000 → -200/22000
    expect(result.total_day_change_pct).toBeCloseTo(-0.909091, 5)
  })

  it('merges the same symbol across accounts with a quantity-weighted cost', async () => {
    const { result } = await setup({
      accounts: [
        { acc_id: 'a', trd_env: 'REAL', acc_role: 'OWNER' },
        { acc_id: 'b', trd_env: 'REAL', acc_role: 'OWNER' },
      ],
      portfolios: {
        a: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 10, cost_price: 100, current_price: 110, market_val: 1100, pl_val: 100 })],
          cash_by_currency: { USD: 500 },
        }),
        b: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 5, cost_price: 130, current_price: 110, market_val: 550, pl_val: -100 })],
          cash_by_currency: { USD: 250, MYR: 1000 },
        }),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: { USDMYR: 4 },
    })

    expect(result.positions).toHaveLength(1)
    const p = result.positions[0]!
    expect(p.qty).toBe(15)
    // (10*100 + 5*130) / 15 = 110
    expect(p.cost_price).toBeCloseTo(110, 6)
    expect(p.market_value).toBeCloseTo(1650, 6)
    expect(p.unrealized_pl).toBeCloseTo(0, 6)
    expect(result.cash_by_currency).toEqual({ USD: 750, MYR: 1000 })
    expect(result.accounts).toEqual(['a', 'b'])
  })

  it('nulls day change and records a caveat when the quote snapshot fails', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [
            pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100 }),
            pos({ code: 'US.BROKEN', qty: 5, cost_price: 10, current_price: 20, market_val: 100 }),
          ],
        }),
      },
      snapshots: {
        'US.NVDA': { prevClosePrice: 100 },
        'US.BROKEN': new Error('quote unavailable'),
      },
      fx: { USDMYR: 4 },
    })

    const broken = result.positions.find(p => p.symbol === 'US.BROKEN')!
    expect(broken.prev_close).toBeNull()
    expect(broken.day_change_value).toBeNull()
    expect(broken.day_change_pct).toBeNull()
    // Market value is still known — only the baseline is missing.
    expect(broken.market_value).toBeCloseTo(100, 6)
    expect(result.caveats.join(' ')).toContain('US.BROKEN')
    expect(result.status).toBe('ok')

    // One unquotable holding must NOT wipe out the headline day change for the
    // other 99% of the book — report the covered part and disclose the gap.
    expect(result.total_day_change_pct).toBeCloseTo(10, 6)
    expect(result.day_change_missing_symbols).toEqual(['US.BROKEN'])
    // 1100 of 1200 native (both USD) has a baseline.
    expect(result.day_change_coverage_pct).toBeCloseTo(91.6667, 3)
  })

  it('reports full coverage when every position has a baseline', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100 })],
        }),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: { USDMYR: 4 },
    })

    expect(result.day_change_coverage_pct).toBeCloseTo(100, 6)
    expect(result.day_change_missing_symbols).toEqual([])
  })

  it('nulls the day change only when nothing has a baseline', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [pos({ code: 'MY.1066', qty: 100, cost_price: 5, current_price: 6, market_val: 600, currency: 'MYR' })],
        }),
      },
      snapshots: { 'MY.1066': new Error('No permission to get quotes for MY.1066') },
      fx: {},
    })

    expect(result.total_day_change_pct).toBeNull()
    expect(result.day_change_coverage_pct).toBe(0)
    expect(result.day_change_missing_symbols).toEqual(['MY.1066'])
    expect(result.caveats.join(' ')).toContain('MY.1066')
  })

  it('guards against a zero previous close', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [pos({ code: 'US.NEW', qty: 10, cost_price: 5, current_price: 6, market_val: 60 })],
        }),
      },
      snapshots: { 'US.NEW': { prevClosePrice: 0 } },
      fx: { USDMYR: 4 },
    })

    const p = result.positions[0]!
    expect(p.day_change_pct).toBeNull()
    expect(p.day_change_value).toBeNull()
    expect(Number.isFinite(result.total_market_value_reporting!)).toBe(true)
  })

  it('keeps native buckets when FX is unavailable and nulls only the blended totals', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100 })],
        }),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: {}, // USD→MYR unresolved
    })

    expect(result.by_currency).toHaveLength(1)
    expect(result.by_currency[0]!.market_value).toBeCloseTo(1100, 6)
    expect(result.total_market_value_reporting).toBeNull()
    expect(result.total_day_change_reporting).toBeNull()
    expect(result.total_day_change_pct).toBeNull()
    expect(result.caveats.join(' ')).toMatch(/USD/)
    expect(result.status).toBe('ok')
  })

  it('reports unavailable — never a net-worth fallback — when there is no live account', async () => {
    const { result } = await setup({
      accounts: [
        { acc_id: 'paper', trd_env: 'SIMULATE', acc_role: 'OWNER' },
        { acc_id: 'ipo', trd_env: 'REAL', acc_role: 'IPO' },
      ],
      portfolios: {},
    })

    expect(result.status).toBe('unavailable')
    expect(result.positions).toEqual([])
    expect(result.total_market_value_reporting).toBeNull()
    expect(result.caveats.join(' ')).toMatch(/live/i)
  })

  it('reports no_positions but still returns cash', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({ positions: [], cash_by_currency: { USD: 1634.12 } }),
      },
      fx: { USDMYR: 4 },
    })

    expect(result.status).toBe('no_positions')
    expect(result.cash_by_currency).toEqual({ USD: 1634.12 })
    expect(result.positions).toEqual([])
  })

  it('aggregates surviving accounts and names the failed one when one errors', async () => {
    const { result } = await setup({
      accounts: [
        { acc_id: 'good', trd_env: 'REAL', acc_role: 'OWNER' },
        { acc_id: 'bad', trd_env: 'REAL', acc_role: 'OWNER' },
      ],
      portfolios: {
        good: portfolio({
          positions: [pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100 })],
        }),
        bad: new Error('opend timeout'),
      },
      snapshots: { 'US.NVDA': { prevClosePrice: 100 } },
      fx: { USDMYR: 4 },
    })

    expect(result.status).toBe('ok')
    expect(result.accounts).toEqual(['good'])
    expect(result.positions).toHaveLength(1)
    expect(result.caveats.join(' ')).toContain('bad')
  })

  it('weights positions by FX-normalised value', async () => {
    const { result } = await setup({
      accounts: [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }],
      portfolios: {
        live: portfolio({
          positions: [
            pos({ code: 'US.NVDA', qty: 10, cost_price: 90, current_price: 110, market_val: 1100, currency: 'USD' }),
            pos({ code: 'HK.00700', qty: 100, cost_price: 280, current_price: 290, market_val: 29_000, currency: 'HKD' }),
          ],
        }),
      },
      snapshots: {
        'US.NVDA': { prevClosePrice: 100 },
        'HK.00700': { prevClosePrice: 300 },
      },
      fx: { USDMYR: 4, HKDMYR: 0.6 },
    })

    const nvda = result.positions.find(p => p.symbol === 'US.NVDA')!
    const tencent = result.positions.find(p => p.symbol === 'HK.00700')!
    // 4400 / 21800 and 17400 / 21800
    expect(nvda.weight_pct).toBeCloseTo(20.1835, 3)
    expect(tencent.weight_pct).toBeCloseTo(79.8165, 3)
    expect(nvda.weight_pct! + tencent.weight_pct!).toBeCloseTo(100, 6)
  })
})
