// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ToolGuideCard from '../../app/components/chat/ToolGuideCard.vue'
import type { ToolGuide } from '../../types/tool-guide'

const guide: ToolGuide = {
  categories: [
    {
      category: 'Portfolio',
      blurb: 'How your money is doing.',
      tools: [
        { name: 'investment_portfolio', what: 'Live moomoo positions with today\'s move.', useWhen: 'You ask how your portfolio did today.', example: 'How did my portfolio do today?', slash: [] },
      ],
    },
    {
      category: 'Research',
      blurb: 'Dig into one company.',
      tools: [
        { name: 'technical_analysis', what: 'Indicator snapshot.', useWhen: 'You want the chart setup.', example: 'TA on NVDA', slash: ['technical-analysis', 'ta'] },
        { name: 'value_stock', what: 'DCF fair value.', useWhen: 'You ask what a stock is worth.', example: 'Is AAPL cheap?', slash: [] },
      ],
    },
  ],
  commands: [
    { name: 'tools', usage: '/tools', description: 'Show this guide.' },
    { name: 'technical-analysis', usage: '/technical-analysis <symbol>', description: 'TA snapshot.' },
  ],
  notes: ['Ghostfolio tracker tools are not configured.'],
}

describe('ToolGuideCard', () => {
  it('shows every category with its tool count and blurb', () => {
    const w = mount(ToolGuideCard, { props: { guide } })
    const summaries = w.findAll('[data-testid="tool-guide-category"] summary').map(s => s.text())
    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toContain('Portfolio')
    expect(summaries[0]).toContain('1')
    expect(summaries[1]).toContain('Research')
    expect(summaries[1]).toContain('2')
    expect(w.text()).toContain('Dig into one company.')
  })

  it('shows what each tool does, when to use it, and its slash commands', () => {
    const text = mount(ToolGuideCard, { props: { guide } }).text()
    expect(text).toContain('Indicator snapshot.')
    expect(text).toContain('You want the chart setup.')
    expect(text).toContain('/technical-analysis')
    expect(text).toContain('/ta')
  })

  it('emits the example prompt when it is clicked', async () => {
    const w = mount(ToolGuideCard, { props: { guide } })
    const example = w.findAll('[data-testid="tool-guide-example"]').find(b => b.text().includes('Is AAPL cheap?'))!
    await example.trigger('click')
    expect(w.emitted('use')).toEqual([['Is AAPL cheap?']])
  })

  it('emits a slash command with a trailing space, ready for its arguments', async () => {
    const w = mount(ToolGuideCard, { props: { guide } })
    const cmd = w.findAll('[data-testid="tool-guide-command"]').find(b => b.text().includes('/technical-analysis'))!
    await cmd.trigger('click')
    expect(w.emitted('use')).toEqual([['/technical-analysis ']])
  })

  it('lists the slash commands and any notes', () => {
    const w = mount(ToolGuideCard, { props: { guide } })
    expect(w.findAll('[data-testid="tool-guide-command"]')).toHaveLength(2)
    expect(w.text()).toContain('/technical-analysis <symbol>')
    expect(w.text()).toContain('Ghostfolio tracker tools are not configured.')
  })

  it('uses no sub-14px text utilities', () => {
    expect(mount(ToolGuideCard, { props: { guide } }).html()).not.toMatch(/text-xs|text-\[1[0-3]px\]/)
  })
})
