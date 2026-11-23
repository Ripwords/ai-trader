// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RunHeader from '../../app/components/research/RunHeader.vue'
import type { AgentEvent } from '../../types/agents'

const EVENTS: AgentEvent[] = [
  { type: 'node-start', node: 'fundamentals_analyst' },
  { type: 'tool-call', node: 'fundamentals_analyst', tool: 'get_earnings_call_transcript', args: {} },
  { type: 'node-start', node: 'risk_manager' },
]

function header(props: Partial<InstanceType<typeof RunHeader>['$props']>) {
  return mount(RunHeader, {
    props: { status: 'complete', events: EVENTS, durationSec: 586, symbol: 'US.AMZN', runId: 'r-1', ...props },
  })
}

describe('RunHeader', () => {
  it('shows how long a finished run took, not a clock still counting', () => {
    const clock = header({ status: 'complete', durationSec: 586 }).find('[data-testid="run-clock"]')
    expect(clock.text()).toContain('9 min 46 s')
    expect(clock.text()).toContain('duration')
    expect(clock.text()).not.toContain('elapsed')
  })

  it('shows a running run as elapsed time on a tape readout', () => {
    const clock = header({ status: 'running', durationSec: 94 }).find('[data-testid="run-clock"]')
    expect(clock.text()).toContain('1:34')
    expect(clock.text()).toContain('elapsed')
  })

  it('shows no clock for a finished run whose end time is unknown', () => {
    expect(header({ status: 'failed', durationSec: null }).find('[data-testid="run-clock"]').exists()).toBe(false)
  })

  it('says nothing about activity once the run has finished', () => {
    expect(header({ status: 'complete' }).find('[data-testid="run-activity"]').exists()).toBe(false)
  })

  it('names a tool call with the node that made it, not the node that started last', () => {
    const events: AgentEvent[] = [
      { type: 'node-start', node: 'market_analyst' },
      { type: 'node-start', node: 'news_analyst' },
      { type: 'tool-call', node: 'market_analyst', tool: 'get_stock_data', args: {} },
    ]
    const activity = header({ status: 'running', events }).find('[data-testid="run-activity"]').text()
    expect(activity).toContain('market analyst')
    expect(activity).toContain('get_stock_data')
    expect(activity).not.toContain('news analyst')
  })

  it('shows a node that started after the last tool call as thinking', () => {
    const activity = header({ status: 'running' }).find('[data-testid="run-activity"]').text()
    expect(activity).toContain('risk manager')
    expect(activity).toContain('thinking')
    expect(activity).not.toContain('get_earnings_call_transcript')
  })
})
