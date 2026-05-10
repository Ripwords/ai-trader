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
})
