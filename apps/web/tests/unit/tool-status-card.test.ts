// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolStatusCard from '../../app/components/chat/ToolStatusCard.vue'

describe('ToolStatusCard', () => {
  it('shows why a tool call failed, so a stopped order says it may have gone through', () => {
    const w = mount(ToolStatusCard, {
      props: { toolName: 'trade_place_order', state: 'output-error', errorText: 'Stopped while the request was in flight. It may still have gone through.' },
    })
    expect(w.text()).toContain('failed')
    expect(w.text()).toContain('It may still have gone through.')
  })

  it('folds a finished call into one quiet line instead of a full card', () => {
    const w = mount(ToolStatusCard, { props: { toolName: 'market_snapshot', state: 'output-available' } })
    expect(w.find('[data-testid="tool-done"]').exists()).toBe(true)
    expect(w.find('.surface-1').exists()).toBe(false)
    expect(w.text()).toContain('Fetched quote')
  })

  it('keeps the card while the call runs', () => {
    const w = mount(ToolStatusCard, { props: { toolName: 'market_snapshot', state: 'input-available', streaming: true } })
    expect(w.find('.surface-1').exists()).toBe(true)
    expect(w.text()).toContain('Fetching quote')
  })
})
