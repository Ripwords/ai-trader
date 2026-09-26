import { reactive, watch, type Ref } from 'vue'
import type { LlmProviderView, LlmSettings, ModelRole, ProviderTestResult } from '../types/llm'

export const MODEL_ROLES: ModelRole[] = ['chat', 'quick']

export type ModelDraft = Record<ModelRole, { providerId: string; modelId: string }>

/**
 * The Settings page's unsaved model choices. The saved selection seeds the
 * draft only when the selection itself changes, so refreshing the provider
 * list after an add, edit or remove keeps what the user picked.
 */
export function useModelSelectionDraft(
  providers: Ref<LlmProviderView[]>,
  saved: Ref<LlmSettings | null | undefined>,
) {
  const draft = reactive<ModelDraft>({
    chat: { providerId: '', modelId: '' },
    quick: { providerId: '', modelId: '' },
  })
  const modelLists = reactive<Record<string, string[]>>({})

  watch(saved, (selection) => {
    for (const role of MODEL_ROLES) {
      const ref = selection?.[role]
      if (ref) Object.assign(draft[role], ref)
    }
  }, { immediate: true })

  watch(providers, (list) => {
    const fallback = list[0]
    if (!fallback) return
    for (const role of MODEL_ROLES) {
      if (!list.some(p => p.id === draft[role].providerId)) {
        draft[role].providerId = fallback.id
        draft[role].modelId = ''
      }
    }
  }, { immediate: true })

  /** A user-initiated switch: a model id rarely means anything to another provider. */
  function selectProvider(role: ModelRole, providerId: string): void {
    const entry = draft[role]
    if (entry.providerId === providerId) return
    const savedRef = saved.value?.[role]
    if (savedRef?.providerId === providerId) entry.modelId = savedRef.modelId
    else if (!modelLists[providerId]?.includes(entry.modelId)) entry.modelId = ''
    entry.providerId = providerId
  }

  function forgetProvider(providerId: string): void {
    delete modelLists[providerId]
  }

  function testTargets(providerId: string): string[] {
    const ids = MODEL_ROLES
      .filter(role => draft[role].providerId === providerId)
      .map(role => draft[role].modelId.trim())
      .filter(Boolean)
    return [...new Set(ids)]
  }

  return { draft, modelLists, selectProvider, forgetProvider, testTargets }
}

export function summarizeTests(
  runs: Array<{ modelId?: string; result: ProviderTestResult }>,
): { ok: boolean; message: string } {
  const failures = runs.flatMap(({ modelId, result }) => (result.ok ? [] : [modelId ? `${modelId}: ${result.error}` : result.error]))
  if (failures.length > 0) return { ok: false, message: failures.join(' · ') }
  const answered = runs.flatMap(run => (run.modelId ? [run.modelId] : []))
  const listed = Math.max(0, ...runs.map(run => (run.result.ok ? run.result.models.length : 0)))
  const parts = ['connected']
  if (answered.length > 0) parts.push(`${answered.join(' and ')} answered`)
  if (listed > 0) parts.push(`${listed} models available`)
  return { ok: true, message: parts.join(' · ') }
}
