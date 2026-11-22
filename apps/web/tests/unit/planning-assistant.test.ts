import { describe, expect, it } from 'vitest'
import type { FullPortfolio, FullPortfolioPosition } from '../../server/lib/holdings'
import { buildPlanningSummary, normalizePlanningSettings, type PlanningSettings } from '../../server/lib/planning'
import { applyPlanningPatch, buildRebalancePlan, planForChat, type Instrument, type RebalanceInputs } from '../../server/lib/planning-assistant'

function position(symbol: string, assetClass: string, value: number, currency = 'MYR'): FullPortfolioPosition {
  return {
    symbol, name: symbol, quantity: value / 10, market_price: 10, market_value: value, investment: value,
    allocation_pct: 0, pnl_pct: 0, asset_class: assetClass, data_source: null, sectors: [], currency,
  }
}

function portfolio(positions: FullPortfolioPosition[]): FullPortfolio {
  const total = positions.reduce((sum, p) => sum + p.market_value, 0)
  return {
    net_worth_total: total, net_worth_currency: 'MYR', cash_total: 0, positions_value: total, total_pnl_pct: 0,
    accounts: [], positions, moomoo_paper: [], moomoo_live: [], moomoo_live_cash: {}, ghostfolio_status: 'ok', moomoo_status: 'ok',
    fetched_at: '2026-11-22T01:00:00.000Z',
  }
}

const settings = (patch: Partial<PlanningSettings> = {}): PlanningSettings => normalizePlanningSettings({
  target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 60 }, { key: 'bond', target_pct: 30 }],
  monthly_expenses: 3000,
  ...patch,
})

describe('applyPlanningPatch', () => {
  it('changes only the fields given and lists each change with its old and new value', () => {
    const out = applyPlanningPatch(settings(), { monthly_expenses: 4000, emergency_fund_months: 9 })
    if ('error' in out) throw new Error(out.error)
    expect(out.next.monthly_expenses).toBe(4000)
    expect(out.next.emergency_fund_months).toBe(9)
    expect(out.next.target_model).toEqual(settings().target_model)
    expect(out.changes).toEqual([
      { field: 'monthly_expenses', before: 3000, after: 4000 },
      { field: 'emergency_fund_months', before: 6, after: 9 },
    ])
  })

  it('merges a partial target model into the current one and accepts it when it totals 100%', () => {
    const out = applyPlanningPatch(settings(), { target_model: [{ key: 'equity', target_pct: 50 }, { key: 'commodity', target_pct: 10 }] })
    if ('error' in out) throw new Error(out.error)
    const pct = Object.fromEntries(out.next.target_model.map(t => [t.key, t.target_pct]))
    expect(pct).toMatchObject({ cash: 10, equity: 50, bond: 30, commodity: 10 })
    expect(out.changes).toContainEqual({ field: 'target_model.equity', before: 60, after: 50 })
    expect(out.changes).toContainEqual({ field: 'target_model.commodity', before: 0, after: 10 })
  })

  it('refuses a target model that does not total 100%, saying what it totals', () => {
    const out = applyPlanningPatch(settings(), { target_model: [{ key: 'equity', target_pct: 70 }] })
    expect(out).toEqual({ error: expect.stringContaining('110%') })
  })

  it('checks the 100% total on the targets as they will be saved, rounded to two decimals', () => {
    const out = applyPlanningPatch(settings(), { target_model: [{ key: 'cash', target_pct: 33.333 }, { key: 'equity', target_pct: 33.333 }, { key: 'bond', target_pct: 33.334 }] })
    expect(out).toEqual({ error: expect.stringContaining('99.99%') })
  })

  it('treats a blank id as a new row instead of overwriting another', () => {
    const base = settings({ liabilities: [{ id: 'liability-2', name: 'Car', balance: 100, interest_rate_pct: 0, minimum_payment: 0 }] })
    const out = applyPlanningPatch(base, { upsert_liabilities: [{ id: ' ', name: 'Card', balance: 50, interest_rate_pct: 0, minimum_payment: 0 }] })
    if ('error' in out) throw new Error(out.error)
    expect(out.next.liabilities.map(l => l.name)).toEqual(['Car', 'Card'])
    expect(new Set(out.next.liabilities.map(l => l.id)).size).toBe(2)
  })

  it('adds, updates and removes liabilities and cashflow items by id', () => {
    const base = settings({
      liabilities: [{ id: 'car', name: 'Car loan', balance: 20_000, interest_rate_pct: 3, minimum_payment: 600 }],
      cashflow_items: [{ id: 'salary', name: 'Salary', kind: 'income', amount: 9000 }],
    })
    const out = applyPlanningPatch(base, {
      upsert_liabilities: [{ id: 'car', name: 'Car loan', balance: 18_000, interest_rate_pct: 3, minimum_payment: 600 }, { name: 'Card', balance: 2000, interest_rate_pct: 18, minimum_payment: 100 }],
      remove_cashflow_ids: ['salary'],
      upsert_cashflow_items: [{ name: 'Rent', kind: 'expense', amount: 2500 }],
    })
    if ('error' in out) throw new Error(out.error)
    expect(out.next.liabilities.map(l => [l.name, l.balance])).toEqual([['Car loan', 18_000], ['Card', 2000]])
    expect(out.next.cashflow_items.map(c => c.name)).toEqual(['Rent'])
    expect(new Set(out.next.liabilities.map(l => l.id)).size).toBe(2)
  })

  it('refuses to remove an id that does not exist instead of reporting a change that did not happen', () => {
    const out = applyPlanningPatch(settings(), { remove_liability_ids: ['nope'] })
    expect(out).toEqual({ error: expect.stringContaining('nope') })
  })

  it('replaces the locked holdings with the list given and reports the change', () => {
    const out = applyPlanningPatch(settings(), { locked_symbols: ['GF_KWSP', 'GF_ASB'] })
    if ('error' in out) throw new Error(out.error)
    expect(out.next.locked_symbols).toEqual(['GF_KWSP', 'GF_ASB'])
    expect(out.changes).toEqual([{ field: 'locked_symbols', before: ['GF_KWSP'], after: ['GF_KWSP', 'GF_ASB'] }])
  })

  it('keeps the locked holdings when the patch does not mention them, including an emptied list', () => {
    const out = applyPlanningPatch(settings({ locked_symbols: [] }), { monthly_expenses: 4000 })
    if ('error' in out) throw new Error(out.error)
    expect(out.next.locked_symbols).toEqual([])
  })

  it('reports no changes when the patch matches the current settings', () => {
    const out = applyPlanningPatch(settings(), { monthly_expenses: 3000 })
    if ('error' in out) throw new Error(out.error)
    expect(out.changes).toEqual([])
  })
})

describe('planForChat', () => {
  // Ghostfolio lists the cash as a holding and also reports an account cash
  // total that leaves some of it out.
  const held = { ...portfolio([position('MMF', 'LIQUIDITY', 18_000), position('VOO', 'EQUITY', 82_000, 'USD')]), cash_total: 6_543 }
  const s = settings({
    monthly_expenses: 0,
    liabilities: [{ id: 'car', name: 'Car loan', balance: 20_000, interest_rate_pct: 3, minimum_payment: 600 }],
    cashflow_items: [{ id: 'salary', name: 'Salary', kind: 'income', amount: 9000 }],
  })
  const plan = planForChat(buildPlanningSummary(held, s), s)

  it('gives one cash figure, the cash row of the allocation', () => {
    expect(plan).not.toHaveProperty('cash_total')
    expect(plan).not.toHaveProperty('positions_value')
    expect(plan.allocation_rows.find(r => r.key === 'cash')?.current_value).toBe(18_000)
    expect(JSON.stringify(plan)).not.toContain('6543')
  })

  it('marks an input the owner has not set instead of reporting it as zero', () => {
    expect(plan.inputs).toMatchObject({ monthly_expenses: 'not set', monthly_contribution: 'not set', emergency_fund_months: 6 })
    const set = settings({ monthly_contribution: 2000 })
    expect(planForChat(buildPlanningSummary(held, set), set).inputs).toMatchObject({ monthly_expenses: 3000, monthly_contribution: 2000 })
  })

  it('states each table once, keeping the ids planning_update needs', () => {
    const text = JSON.stringify(plan)
    expect(text.match(/"target_pct"/g)).toHaveLength(plan.allocation_rows.length)
    expect(text.match(/Car loan/g)).toHaveLength(1)
    expect(text.match(/Salary/g)).toHaveLength(1)
    expect(plan.liabilities.rows[0]?.id).toBe('car')
    expect(plan.inputs.cashflow_items[0]?.id).toBe('salary')
    expect(plan.inputs.locked_symbols).toEqual(['GF_KWSP'])
  })
})

describe('buildRebalancePlan', () => {
  // 100k: cash 10k (10%), equity 80k (80%: VOO 60k, NVDA 20k), bond 10k (10%). Target 10/60/30.
  const p = portfolio([
    position('MMF', 'LIQUIDITY', 10_000),
    position('VOO', 'EQUITY', 60_000, 'USD'),
    position('NVDA', 'EQUITY', 20_000, 'USD'),
    position('AGG', 'FIXED_INCOME', 10_000, 'USD'),
  ])
  const summary = buildPlanningSummary(p, settings())
  const equityShort = buildPlanningSummary(p, settings({ target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 90 }, { key: 'bond', target_pct: 0 }] }))

  const USD = 4.5
  const inst = (symbol: string, bucket: Instrument['bucket'], price: number, currency: 'USD' | 'MYR', held_value: number, patch: Partial<Instrument> = {}): Instrument => {
    const fx_rate = currency === 'USD' ? USD : 1
    return { symbol, name: symbol, bucket, price, currency, fx_rate, held_value, held_shares: held_value / (price * fx_rate), lot_size: 1, candidate: false, ...patch }
  }
  const inputs = (instruments: Instrument[], patch: Partial<RebalanceInputs> = {}): RebalanceInputs => ({
    instruments, skipped: [], broker_cash: { MYR: 2_000, USD: 12.5 }, broker_status: 'ok', fetched_at: '2026-11-22T01:00:00.000Z', ...patch,
  })
  const voo = inst('VOO', 'equity', 100, 'USD', 60_000)
  const nvda = inst('NVDA', 'equity', 50, 'USD', 20_000)
  const agg = inst('AGG', 'bond', 98, 'USD', 10_000)

  it('gives each trade its price, currency, FX rate, whole shares and the value those shares come to', () => {
    const plan = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.trades).toEqual([
      { bucket: 'bond', symbol: 'AGG', name: 'AGG', side: 'buy', shares: 4, lot_size: 1, price: 98, currency: 'USD', fx_rate: 4.5, value_native: 392, value: 1_764 },
    ])
    expect(plan).toMatchObject({ mode: 'contribute_only', base_currency: 'MYR', contribution: 2_000, unallocated: 236 })
  })

  it('reports what the buys need in each currency next to the cash the broker holds and when it was read', () => {
    const plan = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.currencies).toEqual([{ currency: 'USD', fx_rate: 4.5, buy: 392, sell: 0 }])
    expect(plan).toMatchObject({ broker_cash: { MYR: 2_000, USD: 12.5 }, broker_status: 'ok', fetched_at: '2026-11-22T01:00:00.000Z' })
  })

  it('puts the leftover into one more lot of a smaller holding once the split holdings can take no more', () => {
    const big = inst('BIG', 'equity', 450, 'MYR', 60_000)
    const small = inst('SMALL', 'equity', 150, 'MYR', 5_000)
    const plan = buildRebalancePlan(equityShort, inputs([big, small]), { mode: 'contribute_only', contribution: 2_000, maxPerBucket: 1 })
    expect(plan.trades.map(t => [t.symbol, t.shares, t.value])).toEqual([['BIG', 4, 1_800], ['SMALL', 1, 150]])
    expect(plan.skipped).toEqual([])
    expect(plan).toMatchObject({ unallocated: 50 })
  })

  it('spends RM 2,000 on a book of dear US shares down to less than the cheapest share', () => {
    const rate = 4.15
    const book: [string, number, number][] = [['NVDA', 40, 172.14], ['MSFT', 6, 498.3], ['TSM', 12, 245], ['AAPL', 8, 232], ['MU', 15, 118.2], ['JNJ', 5, 158], ['KO', 10, 70.17], ['PLTR', 10, 64]]
    const held = book.map(([symbol, qty, price]) => inst(symbol, 'equity', price, 'USD', qty * price * rate, { fx_rate: rate, held_shares: qty }))
    const plan = buildRebalancePlan(equityShort, inputs(held), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.trades.map(t => [t.symbol, t.shares, t.value])).toEqual([['TSM', 1, 1_016.75], ['NVDA', 1, 714.38], ['PLTR', 1, 265.6]])
    expect(plan.skipped).toEqual([{ symbol: 'MSFT', reason: 'below_one_lot', lot_size: 1, one_lot: 2_067.95 }])
    expect(plan).toMatchObject({ unallocated: 3.27 })
    const cheapest = Math.min(...held.map(i => i.price * i.fx_rate))
    expect(plan.mode === 'contribute_only' && plan.unallocated).toBeLessThan(cheapest)
  })

  it('states its allocation rule in one sentence for each mode', () => {
    const buy = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'contribute_only', contribution: 2_000 })
    const full = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'full' })
    for (const plan of [buy, full]) {
      expect(plan.allocation_rule).toMatch(/one more lot at a time/)
      expect(plan.allocation_rule.match(/\./g)).toHaveLength(1)
    }
    expect(buy.allocation_rule).toMatch(/^New money/)
    expect(full.allocation_rule).toMatch(/^Each bucket is bought or sold to its target/)
  })

  it('leaves a holding out when neither its part nor the leftover buys one lot, spends the money on the rest and says so', () => {
    const dear = inst('DEAR', 'equity', 500, 'USD', 60_000)
    const cheap = inst('CHEAP', 'equity', 20, 'USD', 20_000)
    for (const maxPerBucket of [3, 1]) {
      const plan = buildRebalancePlan(equityShort, inputs([dear, cheap]), { mode: 'contribute_only', contribution: 2_000, maxPerBucket })
      expect(plan.trades.map(t => [t.symbol, t.shares, t.value])).toEqual([['CHEAP', 22, 1_980]])
      expect(plan.skipped).toEqual([{ symbol: 'DEAR', reason: 'below_one_lot', lot_size: 1, one_lot: 2_250 }])
      expect(plan).toMatchObject({ unallocated: 20 })
    }
  })

  it('buys in whole board lots and reports a holding the money cannot buy one lot of, with what a lot costs', () => {
    const us = inst('US', 'equity', 100, 'USD', 60_000)
    const bursa = inst('1066.KL', 'equity', 6.5, 'MYR', 5_000, { lot_size: 100 })
    const split = buildRebalancePlan(equityShort, inputs([us, bursa]), { mode: 'contribute_only', contribution: 2_000 })
    expect(split.trades.map(t => [t.symbol, t.shares])).toEqual([['US', 4]])
    expect(split.skipped).toEqual([{ symbol: '1066.KL', reason: 'below_one_lot', lot_size: 100, one_lot: 650 }])

    const alone = buildRebalancePlan(equityShort, inputs([bursa]), { mode: 'contribute_only', contribution: 2_000 })
    expect(alone.trades).toEqual([
      { bucket: 'equity', symbol: '1066.KL', name: '1066.KL', side: 'buy', shares: 300, lot_size: 100, price: 6.5, currency: 'MYR', fx_rate: 1, value_native: 1_950, value: 1_950 },
    ])
    expect(alone).toMatchObject({ unallocated: 50 })
  })

  it('sells whole board lots only, leaving an odd lot the normal market cannot take', () => {
    const odd = inst('ODD.KL', 'equity', 10, 'MYR', 80_000, { lot_size: 100, held_shares: 1_250 })
    const plan = buildRebalancePlan(summary, inputs([odd, agg]), { mode: 'full' })
    expect(plan.trades.filter(t => t.side === 'sell').map(t => [t.symbol, t.shares])).toEqual([['ODD.KL', 1_200]])
  })

  it('leaves the money unallocated when the broker holds nothing in the bucket, instead of naming a ticker', () => {
    const plan = buildRebalancePlan(summary, inputs([voo, nvda]), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.trades).toEqual([])
    expect(plan.buckets).toEqual([{ key: 'bond', actual_pct: 10, target_pct: 30, planned: 2_000, traded: 0, instruments: 0 }])
    expect(plan).toMatchObject({ unallocated: 2_000 })
  })

  it('splits a bucket equally over the candidates given for it, in place of its holdings', () => {
    const x = inst('X', 'bond', 10, 'MYR', 0, { candidate: true })
    const y = inst('Y', 'bond', 30, 'MYR', 0, { candidate: true })
    const plan = buildRebalancePlan(summary, inputs([voo, agg, x, y]), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.trades.map(t => [t.symbol, t.shares, t.value])).toEqual([['X', 101, 1_010], ['Y', 33, 990]])
    expect(plan).toMatchObject({ unallocated: 0 })
  })

  it('says when a candidate sits in a bucket that gets no money', () => {
    const tsla = inst('TSLA', 'equity', 50, 'USD', 0, { candidate: true })
    const plan = buildRebalancePlan(summary, inputs([agg, tsla]), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.skipped).toEqual([{ symbol: 'TSLA', reason: 'no_amount_for_bucket' }])
    expect(plan.trades.map(t => t.symbol)).toEqual(['AGG'])
  })

  it('keeps the symbols the loader could not use next to the ones it drops itself', () => {
    const plan = buildRebalancePlan(summary, inputs([agg], { skipped: [{ symbol: 'NOPE', reason: 'not_found' }] }), { mode: 'contribute_only', contribution: 2_000 })
    expect(plan.skipped).toEqual([{ symbol: 'NOPE', reason: 'not_found' }])
  })

  it('in contribute-only mode splits the money by shortfall and reports what is over once every shortfall is filled', () => {
    const plan = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'contribute_only', contribution: 30_000 })
    expect(plan.trades.map(t => [t.symbol, t.side, t.shares])).toEqual([['AGG', 'buy', 45]])
    expect(plan.buckets).toEqual([{ key: 'bond', actual_pct: 10, target_pct: 30, planned: 20_000, traded: 19_845, instruments: 1 }])
    expect(plan).toMatchObject({ unallocated: 10_155 })
  })

  it('in full mode sells whole shares of the overweight bucket by size and buys the underweight one, never cash', () => {
    const plan = buildRebalancePlan(summary, inputs([voo, nvda, agg]), { mode: 'full' })
    expect(plan.trades.map(t => [t.symbol, t.side, t.shares, t.value])).toEqual([
      ['VOO', 'sell', 33, 14_850],
      ['NVDA', 'sell', 22, 4_950],
      ['AGG', 'buy', 45, 19_845],
    ])
    expect(plan).toMatchObject({ mode: 'full', cash_change: -45 })
    expect(plan).not.toHaveProperty('unallocated')
    expect(plan.buckets.map(b => [b.key, b.planned, b.traded])).toEqual([['equity', -20_000, -19_800], ['bond', 20_000, 19_845]])
    expect(plan.currencies).toEqual([{ currency: 'USD', fx_rate: 4.5, buy: 4_410, sell: 4_400 }])
  })

  it('spreads a bucket over its largest holdings only', () => {
    const many = [inst('A', 'equity', 10, 'MYR', 40_000), inst('B', 'equity', 10, 'MYR', 20_000), inst('C', 'equity', 10, 'MYR', 10_000), inst('D', 'equity', 10, 'MYR', 10_000)]
    const plan = buildRebalancePlan(summary, inputs([...many, agg]), { mode: 'full', maxPerBucket: 2 })
    expect(plan.trades.filter(t => t.bucket === 'equity').map(t => [t.symbol, t.shares])).toEqual([['A', 1_333], ['B', 667]])
  })

  it('never sells more shares of a holding than the broker holds, taking more holdings when the largest cannot cover the sale', () => {
    const held = [inst('A', 'equity', 10, 'MYR', 4_005), inst('B', 'equity', 10, 'MYR', 3_000), inst('C', 'equity', 10, 'MYR', 73_000)].map(i => ({ ...i }))
    held[2]!.held_value = 2_000
    held[2]!.held_shares = 200
    const s = buildPlanningSummary(p, settings({ target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 72 }, { key: 'bond', target_pct: 18 }] }))
    const plan = buildRebalancePlan(s, inputs(held), { mode: 'full', maxPerBucket: 1 })
    const sells = plan.trades.filter(t => t.side === 'sell')
    for (const t of sells) expect(t.shares).toBeLessThanOrEqual(Math.floor(held.find(i => i.symbol === t.symbol)!.held_shares))
    expect(sells.reduce((sum, t) => sum + t.value, 0)).toBe(8_000)
    expect(sells.map(t => t.symbol)).toEqual(['A', 'B', 'C'])
  })
})
