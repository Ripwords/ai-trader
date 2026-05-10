// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentVerdict from '../../app/components/research/AgentVerdict.vue'

describe('AgentVerdict', () => {
  it('renders rating chip + confidence', () => {
    const wrapper = mount(AgentVerdict, { props: { rating: 'buy', confidence: 72, rationale: 'because', runId: 'r' } })
    expect(wrapper.text()).toContain('buy')
    expect(wrapper.text()).toContain('72')
  })
})
