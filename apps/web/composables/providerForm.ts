import {
  providerCreateSchema,
  providerUpdateSchema,
  type LlmProviderView,
  type ProviderKind,
} from '../types/llm'

interface SettingsFetchError {
  statusMessage?: string
  data?: { message?: string; data?: { code?: string } }
}

/** A settings request's error for display: h3 keeps the useful text in the body's `message`. */
export function settingsErrorMessage(err: unknown, fallback: string): string {
  const e = (typeof err === 'object' && err !== null ? err : {}) as SettingsFetchError
  if (e.data?.data?.code === 'llm_key_unreadable' && e.data.message) return e.data.message
  return e.statusMessage ?? fallback
}

export interface ProviderFormState {
  kind: ProviderKind
  label: string
  baseUrl: string
  apiKey: string
  overrideBaseUrl: boolean
}

function effectiveBaseUrl(state: ProviderFormState): string | null {
  const trimmed = state.baseUrl.trim()
  return state.overrideBaseUrl && trimmed ? trimmed : null
}

export function baseUrlChanged(editing: LlmProviderView | undefined, state: ProviderFormState): boolean {
  return !!editing && effectiveBaseUrl(state) !== editing.baseUrl
}

/** The POST body for a new provider, or the PATCH body for an edit (base URL only when it changed). */
export function providerFormRequest(editing: LlmProviderView | undefined, state: ProviderFormState) {
  const baseUrl = effectiveBaseUrl(state)
  if (!editing) {
    return providerCreateSchema.safeParse({ kind: state.kind, label: state.label, baseUrl, apiKey: state.apiKey })
  }
  return providerUpdateSchema.safeParse({
    label: state.label,
    ...(baseUrlChanged(editing, state) && { baseUrl }),
    ...(state.apiKey.trim() && { apiKey: state.apiKey }),
  })
}
