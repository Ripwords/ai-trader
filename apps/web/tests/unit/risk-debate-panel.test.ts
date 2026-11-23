// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import RiskDebatePanel from '../../app/components/research/RiskDebatePanel.vue'

describe('RiskDebatePanel', () => {
  it('does not repeat the speaker a turn is already labelled with', () => {
    const wrapper = mount(RiskDebatePanel, {
      props: { turns: [{ speaker: 'aggressive', turn: 1, text: 'Aggressive Analyst: Look, before I make the aggressive case, let me be straight about process.' }] },
    })
    expect(wrapper.find('.risk-debate__text').text()).toBe('Look, before I make the aggressive case, let me be straight about process.')
  })
})
