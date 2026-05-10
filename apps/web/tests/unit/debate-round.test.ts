// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DebateRound from '../../app/components/research/DebateRound.vue'

describe('DebateRound', () => {
  it('renders bull and bear text', () => {
    const wrapper = mount(DebateRound, { props: { round: 1, bull: 'BUY THESIS', bear: 'RISK CASE' } })
    expect(wrapper.text()).toContain('BUY THESIS')
    expect(wrapper.text()).toContain('RISK CASE')
  })
})
