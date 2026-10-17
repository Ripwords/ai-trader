import type { PromptView } from '../../../types/prompts'
import { fetchAgentsDefaults, type AgentsDefaults } from './agents-defaults'
import { PROMPT_REGISTRY, type PromptMeta } from './registry'

export interface PromptDefault {
  text: string
  placeholders: string[]
}

export type AgentsDefaultsResult = { ok: true; defaults: AgentsDefaults } | { ok: false; error: string }

export async function loadAgentsDefaults(): Promise<AgentsDefaultsResult> {
  try {
    return { ok: true, defaults: await fetchAgentsDefaults() }
  } catch (err) {
    console.error('[prompts] agents defaults unavailable', err)
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `The agents service could not be reached (${reason}), so the debate prompts cannot be shown or edited right now.` }
  }
}

export function defaultFor(meta: PromptMeta, agents: AgentsDefaultsResult): PromptDefault | null {
  if (meta.engine === 'web') return { text: meta.default, placeholders: [] }
  if (!agents.ok) return null
  return agents.defaults[meta.agentName] ?? null
}

export function toView(meta: PromptMeta, def: PromptDefault | null, override: string | undefined): PromptView {
  return {
    id: meta.id,
    group: meta.group,
    label: meta.label,
    description: meta.description,
    engine: meta.engine,
    placeholders: def?.placeholders ?? [],
    contract: meta.contract ?? null,
    default: def?.text ?? null,
    override: override ?? null,
    modified: override !== undefined,
  }
}

export function listViews(overrides: Record<string, string>, agents: AgentsDefaultsResult): PromptView[] {
  return PROMPT_REGISTRY.map(meta => toView(meta, defaultFor(meta, agents), overrides[meta.id]))
}
