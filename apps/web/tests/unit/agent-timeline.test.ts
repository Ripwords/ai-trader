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

const SPOKEN = 'Bull Analyst: # Bull Case\n\nMargins are widening fast.'

const twoRounds: AgentEvent[] = [
  { type: 'node-start', node: 'Bull Researcher' },
  { type: 'debate-round', round: 1, side: 'bull', text: SPOKEN },
  { type: 'node-end', node: 'Bull Researcher', summary: 'Margins are widening fast.' },
  { type: 'node-start', node: 'Bear Researcher' },
  { type: 'debate-round', round: 1, side: 'bear', text: 'Bear Analyst: Cash flow is negative.' },
  { type: 'node-end', node: 'Bear Researcher', summary: 'Cash flow is negative.' },
  { type: 'node-start', node: 'Bull Researcher' },
]

const riskDebate: AgentEvent[] = [
  { type: 'node-start', node: 'Aggressive Analyst' },
  { type: 'risk-debate-turn', speaker: 'aggressive', turn: 1, text: 'Aggressive Analyst: Add now.' },
  { type: 'node-end', node: 'Aggressive Analyst', summary: 'Add now.' },
  { type: 'node-start', node: 'Conservative Analyst' },
  { type: 'risk-debate-turn', speaker: 'conservative', turn: 2, text: 'Conservative Analyst: Wait.' },
  { type: 'node-end', node: 'Conservative Analyst', summary: 'Wait.' },
  { type: 'node-start', node: 'Neutral Analyst' },
]

function sequence(evs: AgentEvent[]): string[] {
  const wrapper = mount(AgentTimeline, { props: { events: evs } })
  return wrapper.findAll('[data-testid=agent-step-card], [data-testid=debate-round], [data-testid=risk-debate]')
    .map(el => el.attributes('data-testid') === 'agent-step-card' ? el.find('.step__node').text() : el.attributes('data-testid')!)
}

describe('AgentTimeline', () => {
  it('shows a debater as running again while it writes its next round, on its one card', () => {
    const wrapper = mount(AgentTimeline, { props: { events: twoRounds } })
    const cards = wrapper.findAll('[data-testid=agent-step-card]')
    expect(cards.map(c => [c.find('.step__node').text(), c.attributes('data-tone')])).toEqual([
      ['Bull Researcher', 'running'],
      ['Bear Researcher', 'done'],
    ])
  })

  it('lists the debaters above the debate they wrote, not on either side of it', () => {
    expect(sequence(twoRounds)).toEqual(['Bull Researcher', 'Bear Researcher', 'debate-round'])
    expect(sequence(riskDebate)).toEqual(['Aggressive Analyst', 'Conservative Analyst', 'Neutral Analyst', 'risk-debate'])
  })

  it('does not repeat a line under a step whose whole text the timeline already shows', async () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          ...twoRounds,
          { type: 'node-start', node: 'Research Manager' },
          { type: 'synthesis', stage: 'investment-plan', node: 'Research Manager', content: 'Buy on the plan.' },
          { type: 'node-end', node: 'Research Manager', summary: 'Buy on the plan.' },
        ],
      },
    })
    for (const head of wrapper.findAll('.step__head')) await head.trigger('click')
    expect(wrapper.findAll('.summary')).toHaveLength(0)
  })

  it('shows a step as finished once its plan is in, for runs stored without the step\'s end', () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          { type: 'node-start', node: 'Research Manager' },
          { type: 'synthesis', stage: 'investment-plan', node: 'Research Manager', content: 'Buy on the plan.' },
        ],
      },
    })
    expect(wrapper.find('[data-testid=agent-step-card]').attributes('data-tone')).toBe('done')
  })

  it('does not repeat the decision under the step that made it', async () => {
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          { type: 'node-start', node: 'Risk Manager' },
          { type: 'decision', rating: 'buy', confidence: 43, rationale: 'Buy as a modest add.' },
          { type: 'node-end', node: 'Risk Manager', summary: 'Buy as a modest add.' },
        ],
      },
    })
    expect(wrapper.find('.step__chevron').exists()).toBe(false)
  })

  it('marks each of a step\'s tool calls finished when the calls went out together', async () => {
    const call = (tool: string): AgentEvent => ({ type: 'tool-call', node: 'Market Analyst', tool, args: {} })
    const result = (tool: string): AgentEvent => ({ type: 'tool-result', node: 'Market Analyst', tool, ok: true, preview: '' })
    const wrapper = mount(AgentTimeline, {
      props: {
        events: [
          { type: 'node-start', node: 'Market Analyst' },
          call('get_stock_data'), call('get_indicators'), result('get_stock_data'), result('get_indicators'),
          call('get_indicators'), call('get_indicators'), result('get_indicators'), result('get_indicators'),
        ],
      },
    })
    await wrapper.find('.step__head').trigger('click')
    expect(wrapper.findAll('.tool').map(t => t.attributes('data-state'))).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('keeps the summary of a step whose text appears nowhere else', async () => {
    const wrapper = mount(AgentTimeline, { props: { events } })
    await wrapper.find('.step__head').trigger('click')
    expect(wrapper.find('.summary').text()).toBe('looks healthy')
  })

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
