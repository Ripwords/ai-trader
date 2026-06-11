// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentVerdict from '../../app/components/research/AgentVerdict.vue'

describe('AgentVerdict', () => {
  it('renders rating chip + confidence ring when a number is present', () => {
    const wrapper = mount(AgentVerdict, { props: { rating: 'buy', confidence: 72, rationale: 'because', runId: 'r' } })
    expect(wrapper.text()).toContain('buy')
    expect(wrapper.text()).toContain('72')
    expect(wrapper.find('[data-testid="verdict-rating"]').exists()).toBe(true)
  })

  it('shows "conviction unstated" and hides the ring when confidence is null', () => {
    const wrapper = mount(AgentVerdict, { props: { rating: 'hold', confidence: null, rationale: 'because', runId: 'r' } })
    expect(wrapper.text()).toContain('conviction unstated')
    expect(wrapper.text()).not.toContain('%')
    expect(wrapper.find('[data-testid="verdict-rating"]').exists()).toBe(false)
  })

  it('renders the rationale as structured titled sections', () => {
    const rationale = '## Summary\nbulls vs bears\n\n## Rationale\nrisks cancel'
    const wrapper = mount(AgentVerdict, { props: { rating: 'hold', confidence: null, rationale, runId: 'r' } })
    const titles = wrapper.findAll('.verdict__section-title').map(t => t.text())
    expect(titles).toEqual(['Summary', 'Rationale'])
  })

  it('does not render a "send to paper" action', () => {
    const wrapper = mount(AgentVerdict, { props: { rating: 'buy', confidence: 72, rationale: 'x', runId: 'r' } })
    expect(wrapper.text().toLowerCase()).not.toContain('send to paper')
  })
})
