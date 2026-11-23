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

  it('renders a turn\'s opening heading as a heading, without the speaker it is already filed under', () => {
    const wrapper = mount(DebateRound, {
      props: {
        round: 1,
        bull: 'Bull Analyst: # Bull Case for AMZN — The Bear Is Pricing a Capex Cycle\n\nLet me start where the bear always starts.',
        bear: 'Bear Analyst: # Bear Case for AMZN — The Bull Is Buying a Narrative\n\nLet me start by conceding something real.',
      },
    })
    expect(wrapper.findAll('h1').map(h => h.text())).toEqual([
      'Bull Case for AMZN — The Bear Is Pricing a Capex Cycle',
      'Bear Case for AMZN — The Bull Is Buying a Narrative',
    ])
    expect(wrapper.text()).not.toContain('Bull Analyst:')
    expect(wrapper.text()).not.toContain('#')
  })
})
