// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { defineComponent, h, Suspense } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import AgentsDebateCard from '../../app/components/chat/AgentsDebateCard.vue'

function mountCard(rationale: string) {
  return mount(defineComponent({
    render: () => h(Suspense, null, {
      default: () => h(AgentsDebateCard, {
        events: [],
        verdict: { rating: 'sell', confidence: 70, rationale },
      }),
    }),
  }))
}

describe('AgentsDebateCard', () => {
  it('renders the verdict rationale as markdown, not raw text', async () => {
    const wrapper = mountCard('**Decision: SELL**\n\n### 1. Synthesis\n\n- reduce longs')
    await flushPromises()
    expect(wrapper.find('strong').text()).toBe('Decision: SELL')
    expect(wrapper.find('h3').text()).toContain('Synthesis')
    expect(wrapper.find('li').text()).toBe('reduce longs')
    expect(wrapper.text()).not.toContain('**')
    expect(wrapper.text()).not.toContain('###')
  })

  it('keeps the rating badge and confidence', async () => {
    const wrapper = mountCard('plain')
    await flushPromises()
    expect(wrapper.text()).toContain('sell')
    expect(wrapper.text()).toContain('conf 70')
  })
})
