// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentStepCard from '../../app/components/research/AgentStepCard.vue'

describe('AgentStepCard', () => {
  it('offers nothing to open when the step has no tool calls, report or summary', async () => {
    const wrapper = mount(AgentStepCard, {
      props: { node: 'Bull Researcher', toolCalls: [], summary: null, state: 'done' },
    })
    expect(wrapper.find('.step__chevron').exists()).toBe(false)
    await wrapper.find('.step__head').trigger('click')
    expect(wrapper.find('.step__body').exists()).toBe(false)
  })

  it('opens to the summary of a step that has one', async () => {
    const wrapper = mount(AgentStepCard, {
      props: { node: 'Market Analyst', toolCalls: [], summary: 'Price is above the 50-day.', state: 'done' },
    })
    expect(wrapper.find('.step__chevron').exists()).toBe(true)
    await wrapper.find('.step__head').trigger('click')
    expect(wrapper.find('.summary').text()).toBe('Price is above the 50-day.')
  })

  // @nuxt/icon writes a late-loading icon's CSS under the class the instance
  // has when the load resolves. An instance whose name changed from diamond to
  // check in the meantime paints the diamond under the check class.
  it('mounts a new icon when the state changes instead of renaming the old one', async () => {
    const wrapper = mount(AgentStepCard, {
      props: { node: 'market_analyst', toolCalls: [], summary: null, state: 'running' },
    })
    const running = wrapper.find('.step__rule-glyph').element
    expect(running.getAttribute('name')).toBe('i-lucide-diamond')

    await wrapper.setProps({ state: 'done' })

    const done = wrapper.find('.step__rule-glyph').element
    expect(done.getAttribute('name')).toBe('i-lucide-check')
    expect(done).not.toBe(running)
  })
})
