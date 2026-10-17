import { describe, expect, it } from 'vitest'
import { groupPrompts, parseSettingsTab } from '../../app/utils/settings-view'
import type { PromptView } from '../../types/prompts'

const view = (id: string, group: PromptView['group']): PromptView => ({
  id, group, label: id, description: '', engine: 'web', placeholders: [], contract: null, default: 'd', override: null, modified: false,
})

describe('parseSettingsTab', () => {
  it('reads a known tab and falls back to models', () => {
    expect(parseSettingsTab('prompts')).toBe('prompts')
    expect(parseSettingsTab('notifications')).toBe('notifications')
    expect(parseSettingsTab('nope')).toBe('models')
    expect(parseSettingsTab(undefined)).toBe('models')
  })
})

describe('groupPrompts', () => {
  it('orders groups chat → agents and drops empty ones', () => {
    const groups = groupPrompts([view('a.x', 'agents'), view('c.x', 'chat'), view('c.y', 'chat')])
    expect(groups.map(g => g.label)).toEqual(['Chat', 'Agents debate'])
    expect(groups[0]!.prompts.map(p => p.id)).toEqual(['c.x', 'c.y'])
  })
})
