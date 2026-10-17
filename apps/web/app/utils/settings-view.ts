import { PROMPT_GROUP_LABELS, type PromptGroup, type PromptView } from '../../types/prompts'

export const SETTINGS_TABS = [
  { value: 'models', label: 'models' },
  { value: 'notifications', label: 'notifications' },
  { value: 'prompts', label: 'prompts' },
] as const

export type SettingsTab = typeof SETTINGS_TABS[number]['value']

export function parseSettingsTab(q: unknown): SettingsTab {
  return SETTINGS_TABS.find(t => t.value === q)?.value ?? 'models'
}

const GROUP_ORDER: PromptGroup[] = ['chat', 'research', 'news', 'algo', 'agents']

export interface PromptGroupView {
  group: PromptGroup
  label: string
  prompts: PromptView[]
}

/** Prompts in Settings order, one entry per non-empty group. */
export function groupPrompts(prompts: PromptView[]): PromptGroupView[] {
  return GROUP_ORDER
    .map(group => ({ group, label: PROMPT_GROUP_LABELS[group], prompts: prompts.filter(p => p.group === group) }))
    .filter(g => g.prompts.length > 0)
}
