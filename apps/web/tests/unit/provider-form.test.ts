import { describe, expect, it } from 'vitest'
import { baseUrlChanged, providerFormRequest, settingsErrorMessage, type ProviderFormState } from '../../composables/providerForm'
import { KEY_REQUIRED_FOR_BASE_URL, type LlmProviderView } from '../../types/llm'

const stored: LlmProviderView = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://gateway.example.com/v1',
  apiKeyHint: '…abcd',
}

function state(patch: Partial<ProviderFormState> = {}): ProviderFormState {
  return { kind: 'openai', label: 'OpenAI', baseUrl: stored.baseUrl!, apiKey: '', overrideBaseUrl: true, ...patch }
}

describe('settingsErrorMessage', () => {
  it('shows the explanation for a key that no longer decrypts', () => {
    const err = { statusMessage: 'llm_key_unreadable', data: { message: 'Re-enter its key.', data: { code: 'llm_key_unreadable' } } }
    expect(settingsErrorMessage(err, 'Test failed.')).toBe('Re-enter its key.')
  })

  it('falls back to the status message, then the default', () => {
    expect(settingsErrorMessage({ statusMessage: 'Provider not found' }, 'Test failed.')).toBe('Provider not found')
    expect(settingsErrorMessage(new Error('network'), 'Test failed.')).toBe('Test failed.')
  })
})

describe('provider form request', () => {
  it('leaves the base URL out of an edit that does not change it, so the key may stay blank', () => {
    expect(baseUrlChanged(stored, state())).toBe(false)
    const parsed = providerFormRequest(stored, state({ label: 'Work' }))
    expect(parsed.success && parsed.data).toEqual({ label: 'Work' })
  })

  it('needs the key when the base URL changes or goes back to the default', () => {
    for (const s of [state({ baseUrl: 'https://other.example.com/v1' }), state({ overrideBaseUrl: false })]) {
      expect(baseUrlChanged(stored, s)).toBe(true)
      const parsed = providerFormRequest(stored, s)
      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: ['apiKey'], message: KEY_REQUIRED_FOR_BASE_URL })])
    }
    const parsed = providerFormRequest(stored, state({ overrideBaseUrl: false, apiKey: 'sk-new' }))
    expect(parsed.success && parsed.data).toEqual({ label: 'OpenAI', baseUrl: null, apiKey: 'sk-new' })
  })

  it('treats a new provider as a create with the key always required', () => {
    expect(baseUrlChanged(undefined, state())).toBe(false)
    expect(providerFormRequest(undefined, state({ overrideBaseUrl: false })).success).toBe(false)
    const parsed = providerFormRequest(undefined, state({ overrideBaseUrl: false, apiKey: 'sk-1' }))
    expect(parsed.success && parsed.data).toEqual({ kind: 'openai', label: 'OpenAI', baseUrl: null, apiKey: 'sk-1' })
  })
})
