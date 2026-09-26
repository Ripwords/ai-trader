import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { summarizeTests, useModelSelectionDraft } from '../../composables/useModelSelectionDraft'
import type { LlmProviderView, LlmSettings } from '../../types/llm'

const anthropic: LlmProviderView = { id: 'p-anthropic', kind: 'anthropic', label: 'Anthropic', baseUrl: null, apiKeyHint: '…1111' }
const openai: LlmProviderView = { id: 'p-openai', kind: 'openai', label: 'OpenAI', baseUrl: null, apiKeyHint: '…2222' }
const router: LlmProviderView = { id: 'p-router', kind: 'openrouter', label: 'OpenRouter', baseUrl: null, apiKeyHint: '…3333' }

const savedSelection: LlmSettings = {
  chat: { providerId: anthropic.id, modelId: 'claude-sonnet-4-6' },
  quick: { providerId: anthropic.id, modelId: 'claude-haiku-4-5' },
}

function setup(providers = [anthropic, openai], selection: LlmSettings | null = savedSelection) {
  const providerList = ref(providers)
  const saved = ref<LlmSettings | null>(selection)
  return { providerList, saved, ...useModelSelectionDraft(providerList, saved) }
}

describe('useModelSelectionDraft', () => {
  it('seeds the draft from the saved selection', () => {
    const { draft } = setup()
    expect(draft.chat).toEqual(savedSelection.chat)
    expect(draft.quick).toEqual(savedSelection.quick)
  })

  it('defaults to the first provider with no model when nothing is saved', () => {
    const { draft } = setup([openai], null)
    expect(draft.chat).toEqual({ providerId: openai.id, modelId: '' })
  })

  it('clears the model when the user switches to a provider that does not list it', () => {
    const { draft, selectProvider } = setup()
    selectProvider('chat', openai.id)
    expect(draft.chat).toEqual({ providerId: openai.id, modelId: '' })
  })

  it('keeps the model when the new provider lists it, and restores the saved model on switching back', () => {
    const { draft, modelLists, selectProvider } = setup([anthropic, router])
    modelLists[router.id] = ['claude-sonnet-4-6', 'qwen/qwen3-32b']
    selectProvider('chat', router.id)
    expect(draft.chat.modelId).toBe('claude-sonnet-4-6')
    draft.chat.modelId = 'qwen/qwen3-32b'
    selectProvider('chat', anthropic.id)
    expect(draft.chat).toEqual(savedSelection.chat)
  })

  it('keeps unsaved choices when the provider list refreshes', async () => {
    const { draft, providerList } = setup()
    draft.chat.modelId = 'claude-opus-4-1'
    providerList.value = [anthropic, openai, router]
    await nextTick()
    expect(draft.chat.modelId).toBe('claude-opus-4-1')
  })

  it('moves a role off a removed provider and clears its model', async () => {
    const { draft, providerList, selectProvider } = setup()
    selectProvider('quick', openai.id)
    draft.quick.modelId = 'gpt-4o-mini'
    providerList.value = [anthropic]
    await nextTick()
    expect(draft.quick).toEqual({ providerId: anthropic.id, modelId: '' })
    expect(draft.chat).toEqual(savedSelection.chat)
  })

  it('re-seeds when the saved selection itself changes', async () => {
    const { draft, saved } = setup()
    draft.chat.modelId = 'unsaved'
    saved.value = { ...savedSelection, chat: { providerId: openai.id, modelId: 'gpt-4o' } }
    await nextTick()
    expect(draft.chat).toEqual({ providerId: openai.id, modelId: 'gpt-4o' })
  })

  it('tests every distinct model the draft points at this provider', () => {
    const { draft, testTargets } = setup()
    expect(testTargets(anthropic.id)).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5'])
    draft.quick.modelId = 'claude-sonnet-4-6'
    expect(testTargets(anthropic.id)).toEqual(['claude-sonnet-4-6'])
    expect(testTargets(openai.id)).toEqual([])
  })

  it('forgets a provider\'s model list after it is edited', () => {
    const { modelLists, forgetProvider } = setup()
    modelLists[anthropic.id] = ['claude-sonnet-4-6']
    forgetProvider(anthropic.id)
    expect(modelLists[anthropic.id]).toBeUndefined()
  })
})

describe('summarizeTests', () => {
  it('reports each model that answered and the listing size', () => {
    expect(summarizeTests([
      { modelId: 'a', result: { ok: true, models: ['a', 'b', 'c'] } },
      { modelId: 'b', result: { ok: true, models: ['a', 'b', 'c'] } },
    ])).toEqual({ ok: true, message: 'connected · a and b answered · 3 models available' })
    expect(summarizeTests([{ result: { ok: true, models: [] } }])).toEqual({ ok: true, message: 'connected' })
  })

  it('fails when any model fails and names it', () => {
    expect(summarizeTests([
      { modelId: 'a', result: { ok: true, models: [] } },
      { modelId: 'b', result: { ok: false, error: 'model not found' } },
    ])).toEqual({ ok: false, message: 'b: model not found' })
  })
})
