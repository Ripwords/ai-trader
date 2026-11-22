import { describe, expect, it } from 'vitest'
import type { FullPortfolio, FullPortfolioPosition } from '../../server/lib/holdings'
import { buildPlanningSummary, normalizePlanningSettings, type PlanningSettings } from '../../server/lib/planning'
import { applyPlanningPatch, buildRebalancePlan, planForChat } from '../../server/lib/planning-assistant'

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
    accounts: [], positions, moomoo_paper: [], moomoo_live: [], ghostfolio_status: 'ok', moomoo_status: 'ok',
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

  it('in full mode sells the overweight bucket across its holdings by size and buys the underweight one', () => {
    const plan = buildRebalancePlan(summary, p, { mode: 'full' })
    expect(plan.trades).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'VOO', side: 'sell', value: 15_000 }),
      expect.objectContaining({ symbol: 'NVDA', side: 'sell', value: 5_000 }),
      expect.objectContaining({ symbol: 'AGG', side: 'buy', value: 20_000 }),
    ]))
    expect(plan.trades.some(t => t.bucket === 'cash')).toBe(false)
  })

  it('never proposes selling a locked holding', () => {
    const withPension = portfolio([...p.positions, position('GF_KWSP', 'FIXED_INCOME', 50_000)])
    const s = buildPlanningSummary(withPension, settings({ target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 85 }, { key: 'bond', target_pct: 5 }] }))
    const plan = buildRebalancePlan(s, withPension, { mode: 'full' })
    expect(plan.trades.map(t => t.symbol)).not.toContain('GF_KWSP')
    expect(plan.trades).toContainEqual(expect.objectContaining({ symbol: 'AGG', side: 'sell', value: 5_000 }))
  })

  it('in contribute-only mode never sells and splits the new money by shortfall', () => {
    const plan = buildRebalancePlan(summary, p, { mode: 'contribute_only', contribution: 5_000 })
    expect(plan.trades.every(t => t.side === 'buy')).toBe(true)
    expect(plan.trades).toEqual([expect.objectContaining({ symbol: 'AGG', side: 'buy', value: 5_000 })])
    expect(plan.unallocated_contribution).toBe(0)
  })

  it('in contribute-only mode leaves money over once every shortfall is filled', () => {
    const plan = buildRebalancePlan(summary, p, { mode: 'contribute_only', contribution: 30_000 })
    expect(plan.trades).toEqual([expect.objectContaining({ symbol: 'AGG', value: 20_000 })])
    expect(plan.unallocated_contribution).toBe(10_000)
  })

  it('names a bucket with no holding to buy into instead of inventing a ticker', () => {
    const s = buildPlanningSummary(p, settings({ target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 60 }, { key: 'bond', target_pct: 20 }, { key: 'commodity', target_pct: 10 }] }))
    const plan = buildRebalancePlan(s, p, { mode: 'full' })
    expect(plan.trades).toContainEqual(expect.objectContaining({ bucket: 'commodity', symbol: null, side: 'buy', value: 10_000 }))
  })

  it('spreads a bucket over its largest holdings only, so small amounts are not split into slices smaller than a share', () => {
    const many = portfolio([
      position('MMF', 'LIQUIDITY', 10_000),
      position('A', 'EQUITY', 40_000), position('B', 'EQUITY', 20_000), position('C', 'EQUITY', 10_000),
      position('D', 'EQUITY', 5_000), position('E', 'EQUITY', 5_000),
      position('AGG', 'FIXED_INCOME', 10_000),
    ])
    const plan = buildRebalancePlan(buildPlanningSummary(many, settings()), many, { mode: 'full', maxPerBucket: 2 })
    expect(plan.trades.filter(t => t.bucket === 'equity').map(t => [t.symbol, t.value])).toEqual([['A', 13_333.33], ['B', 6_666.67]])
  })

  it('never sells more of a holding than it is worth when the largest few cannot cover the sale', () => {
    const many = portfolio([
      position('MMF', 'LIQUIDITY', 1000),
      position('A', 'EQUITY', 400), position('B', 'EQUITY', 300), position('C', 'EQUITY', 200),
      position('D', 'EQUITY', 60), position('E', 'EQUITY', 40),
      position('AGG', 'FIXED_INCOME', 0.01),
    ])
    const s = buildPlanningSummary(many, settings({ target_model: [{ key: 'cash', target_pct: 50 }, { key: 'equity', target_pct: 0 }, { key: 'bond', target_pct: 50 }] }))
    const plan = buildRebalancePlan(s, many, { mode: 'full', maxPerBucket: 3 })
    const sells = plan.trades.filter(t => t.side === 'sell')
    for (const t of sells) expect(t.value).toBeLessThanOrEqual(many.positions.find(p => p.symbol === t.symbol)!.market_value)
    expect(sells.reduce((sum, t) => sum + t.value, 0)).toBeCloseTo(1000, 1)
  })

  it('counts contribution slices too small to trade as unallocated instead of losing them', () => {
    const tiny = portfolio([position('MMF', 'LIQUIDITY', 10_000), position('A', 'EQUITY', 1), position('B', 'EQUITY', 1), position('AGG', 'FIXED_INCOME', 89_998)])
    const plan = buildRebalancePlan(buildPlanningSummary(tiny, settings()), tiny, { mode: 'contribute_only', contribution: 1.5 })
    const placed = plan.trades.reduce((sum, t) => sum + t.value, 0)
    expect(placed + plan.unallocated_contribution).toBeCloseTo(1.5, 2)
  })

  it('gives a share count only when the holding trades in the base currency', () => {
    const local = portfolio([position('MMF', 'LIQUIDITY', 10_000), position('MAYBANK', 'EQUITY', 90_000)])
    const plan = buildRebalancePlan(buildPlanningSummary(local, settings()), local, { mode: 'full' })
    expect(plan.trades.find(t => t.symbol === 'MAYBANK')?.approx_quantity).toBe(3000)
    const usd = buildRebalancePlan(summary, p, { mode: 'full' })
    expect(usd.trades.find(t => t.symbol === 'VOO')?.approx_quantity).toBeNull()
  })
})
