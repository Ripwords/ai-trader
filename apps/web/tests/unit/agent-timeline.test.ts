// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentTimeline from '../../app/components/research/AgentTimeline.vue'
import type { AgentEvent } from '../../types/agents'

const events: AgentEvent[] = [
  { type: 'run-start', run_id: 'r', symbol: 'NVDA', config: {} },
  { type: 'node-start', node: 'fundamentals_analyst' },
  { type: 'tool-call', node: 'fundamentals_analyst', tool: 'get_balance_sheet', args: { ticker: 'NVDA' } },
  { type: 'tool-result', node: 'fundamentals_analyst', tool: 'get_balance_sheet', ok: true, preview: '...' },
  { type: 'node-end', node: 'fundamentals_analyst', summary: 'looks healthy' },
  { type: 'node-start', node: 'bull_researcher' },
  { type: 'debate-round', round: 1, side: 'bull', text: 'buy thesis...' },
  { type: 'debate-round', round: 1, side: 'bear', text: 'risk thesis...' },
  { type: 'node-end', node: 'bull_researcher', summary: 'bull won' },
]

describe('AgentTimeline', () => {
  it('renders one card per node-start', () => {
    const wrapper = mount(AgentTimeline, { props: { events } })
    const cards = wrapper.findAll('[data-testid=agent-step-card]')
    expect(cards.length).toBe(2)
  })

  it('renders DebateRound block for debate events', () => {
    const wrapper = mount(AgentTimeline, { props: { events } })
    expect(wrapper.find('[data-testid=debate-round]').exists()).toBe(true)
  })

  const valuationText = (extra: AgentEvent[]) =>
    mount(AgentTimeline, { props: { events: [...events, ...extra] } }).find('[data-testid=valuation-state]')

  it('states that the run was priced on multiples only, and why the DCF was skipped', () => {
    const row = valuationText([{
      type: 'valuation',
      status: 'multiples_only',
      reason: 'DCF skipped: non-positive FCF or missing shares; multiples-only (no fabricated fair value)',
    }])
    expect(row.text().replace(/\s+/g, ' ')).toBe('Valuation: multiples only. DCF skipped: non-positive FCF or missing shares.')
  })

  it('states a computed DCF and an unavailable valuation in plain words', () => {
    expect(valuationText([{ type: 'valuation', status: 'ok', reason: null }]).text().replace(/\s+/g, ' '))
      .toBe('Valuation: DCF fair value computed.')
    expect(valuationText([{ type: 'valuation', status: 'unavailable', reason: 'no financial statements' }]).text().replace(/\s+/g, ' '))
      .toBe('Valuation: unavailable. No financial statements.')
  })

  it('shows the valuation once when a resumed run reports it again', () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          ...events,
          { type: 'valuation', status: 'unavailable', reason: 'fetch failed' },
          { type: 'valuation', status: 'ok', reason: null },
        ],
      },
    })
    const rows = wrapper.findAll('[data-testid=valuation-state]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('DCF fair value computed')
  })

  it('shows no valuation line for a run that recorded none', () => {
    expect(valuationText([]).exists()).toBe(false)
  })

  it('keeps the veto next to the valuation it came from', () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          ...events,
          { type: 'valuation', status: 'ok', reason: null },
          { type: 'valuation-veto', original_rating: 'buy', effective_rating: 'hold', reason: 'price is 40% above fair value', rating_cap: 'hold' },
        ],
      },
    })
    expect(wrapper.find('[data-testid=valuation-state]').exists()).toBe(true)
    expect(wrapper.find('.valuation-veto-banner').text()).toContain('price is 40% above fair value')
  })
})
