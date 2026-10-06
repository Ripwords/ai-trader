// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StatTile from '../../app/components/ui/StatTile.vue'
import PageState from '../../app/components/ui/PageState.vue'
import StatusPill from '../../app/components/ui/StatusPill.vue'

describe('StatTile', () => {
  it('shows label, value and sub, toned by direction', () => {
    const w = mount(StatTile, { props: { label: 'p&l on cost', value: '+45.06%', sub: 'unrealised', tone: 'up' } })
    expect(w.find('.stat-tile__label').text()).toBe('p&l on cost')
    expect(w.find('.stat-tile__value').text()).toBe('+45.06%')
    expect(w.find('.stat-tile__value').classes()).toContain('tape-up')
    expect(w.find('.stat-tile__sub').text()).toBe('unrealised')
  })

  it('omits an empty sub line', () => {
    const w = mount(StatTile, { props: { label: 'cash', value: '—', sub: '' } })
    expect(w.find('.stat-tile__sub').exists()).toBe(false)
  })
})

describe('PageState', () => {
  it('renders an error as an alert with a retry that emits', async () => {
    const w = mount(PageState, { props: { kind: 'error', message: 'planning failed to load', onRetry: () => {} } })
    expect(w.attributes('role')).toBe('alert')
    expect(w.text()).toContain('planning failed to load')
    await w.find('button').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })

  it('has no retry button when nobody listens', () => {
    const w = mount(PageState, { props: { kind: 'error', message: 'x' } })
    expect(w.find('button').exists()).toBe(false)
  })

  it('announces loading politely and empty plainly', () => {
    expect(mount(PageState, { props: { kind: 'loading', message: 'loading holdings…' } }).attributes('role')).toBe('status')
    const empty = mount(PageState, { props: { kind: 'empty', message: 'no positions' } })
    expect(empty.attributes('role')).toBeUndefined()
    expect(empty.text()).toBe('no positions')
  })
})

describe('StatusPill', () => {
  it('pairs a flat dot with its label', () => {
    const w = mount(StatusPill, { props: { tone: 'down', label: 'opend · down' } })
    expect(w.text()).toBe('opend · down')
    expect(w.find('.status-pill__dot').classes()).toContain('status-pill__dot--down')
  })
})
