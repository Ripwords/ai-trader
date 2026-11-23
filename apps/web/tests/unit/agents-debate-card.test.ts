// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { defineComponent, h, ref, Suspense } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import AgentsDebateCard from '../../app/components/chat/AgentsDebateCard.vue'

const stored = {
  runId: 'run-1', run_url: '/research/US.AMZN?run=run-1',
  rating: 'hold', rating_cap: { original_rating: 'buy', reason: 'price > 2x fair value' },
  confidence: 33, bull_case: 'AWS grew 39.3%.', bear_case: 'Debt rose to $173.1B.',
  rationale: 'Hold above $226.13.', rationale_truncated: true,
}

async function mountCard(output: unknown, running = false) {
  const current = ref(output)
  const wrapper = mount(defineComponent({
    render: () => h(Suspense, null, { default: () => h(AgentsDebateCard, { output: current.value, running }) }),
  }), { global: { stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
  await flushPromises()
  return { wrapper, current }
}

describe('AgentsDebateCard', () => {
  it('renders the verdict rationale as markdown, not raw text', async () => {
    const { wrapper } = await mountCard({ rating: 'sell', confidence: 70, rationale: '**Decision: SELL**\n\n### 1. Synthesis\n\n- reduce longs' })
    expect(wrapper.find('strong').text()).toBe('Decision: SELL')
    expect(wrapper.find('h3').text()).toContain('Synthesis')
    expect(wrapper.find('li').text()).toBe('reduce longs')
    expect(wrapper.text()).not.toContain('**')
    expect(wrapper.text()).not.toContain('###')
  })

  it('renders a finished rationale as written, without closing an odd dollar sign', async () => {
    const { wrapper } = await mountCard({ rating: 'buy', confidence: 70, rationale: '- $250, then $262.43, then $267.' })
    expect(wrapper.find('li').text()).toBe('$250, then $262.43, then $267.')
  })

  it('labels the confidence as the 7-day probability it is', async () => {
    const { wrapper } = await mountCard(stored)
    expect(wrapper.text()).toContain('hold')
    expect(wrapper.text()).toContain('33% chance the stock finishes within 1 percentage point of SPY over 7 trading days')
  })

  it('shows the owner verdict when the run answered one, and nothing for an older result', async () => {
    const { wrapper } = await mountCard({ ...stored, owner_verdict: 'trim' })
    expect(wrapper.find('[data-testid="debate-owner-verdict"]').text().replace(/\s+/g, ' ')).toBe('For your position: Trim')

    const older = await mountCard(stored)
    expect(older.wrapper.find('[data-testid="debate-owner-verdict"]').exists()).toBe(false)
  })

  it('says when there is no confidence score', async () => {
    const { wrapper } = await mountCard({ ...stored, confidence: null })
    expect(wrapper.text()).toContain('no confidence score')
  })

  it('shows the rating the valuation capped, and why', async () => {
    const { wrapper } = await mountCard(stored)
    expect(wrapper.text()).toContain('capped from buy')
    expect(wrapper.text()).toContain('price > 2x fair value')
  })

  it('shows the bull and bear cases', async () => {
    const { wrapper } = await mountCard(stored)
    expect(wrapper.text()).toContain('AWS grew 39.3%.')
    expect(wrapper.text()).toContain('Debt rose to $173.1B.')
  })

  it('omits the cap and the cases for a run that has none', async () => {
    const { wrapper } = await mountCard({ rating: 'sell', confidence: 70, rationale: 'Sell.' })
    expect(wrapper.text()).not.toContain('capped')
    expect(wrapper.text()).not.toContain('Bull')
    expect(wrapper.find('a').exists()).toBe(false)
  })

  it('links the run page, as the full report when the rationale is shortened', async () => {
    const { wrapper } = await mountCard(stored)
    expect(wrapper.find('a').attributes('href')).toBe('/research/US.AMZN?run=run-1')
    expect(wrapper.find('a').text()).toMatch(/full/i)
  })

  it('keeps the steps on screen once the verdict replaces the progress output', async () => {
    const { wrapper, current } = await mountCard({ runId: 'run-1', events: [{ type: 'node-start', node: 'Market Analyst' }] }, true)
    expect(wrapper.text()).toContain('Market Analyst')
    current.value = stored
    await flushPromises()
    expect(wrapper.text()).toContain('Market Analyst')
    expect(wrapper.text()).toContain('verdict ready')
  })

  it('shows the failure when the run produced no verdict', async () => {
    const { wrapper } = await mountCard({ runId: 'run-1', rating: null, error: 'run failed: agents service unreachable' })
    expect(wrapper.text()).toContain('run failed: agents service unreachable')
    expect(wrapper.text()).toContain('failed')
  })

  it('shows the failure beside a verdict the run still reached', async () => {
    const { wrapper } = await mountCard({ ...stored, error: 'run failed: confidence judge crashed' })
    expect(wrapper.text()).toContain('hold')
    expect(wrapper.text()).toContain('run failed: confidence judge crashed')
  })
})
