<script setup lang="ts">
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import ProviderFormModal from '~/components/settings/ProviderFormModal.vue'
import { settingsErrorMessage } from '../../composables/providerForm'
import { summarizeTests, useModelSelectionDraft } from '../../composables/useModelSelectionDraft'
import {
  PROVIDER_KIND_META,
  type LlmProviderView,
  type LlmSettings,
  type ModelRole,
  type ProviderTestResult,
} from '../../types/llm'

const overlay = useOverlay()
const toast = useToast()

const { data: providerData, pending, error, refresh: refreshProviders } = useFetch<{ providers: LlmProviderView[] }>(
  '/api/settings/llm/providers',
  { key: 'llm-providers' },
)
const { data: selectionData } = useFetch<{ selection: LlmSettings | null }>(
  '/api/settings/llm/selection',
  { key: 'llm-selection' },
)
const providers = computed(() => providerData.value?.providers ?? [])

const ROLES: Array<{ role: ModelRole; label: string; description: string }> = [
  { role: 'chat', label: 'Chat model', description: 'Chat, risk reports, strategy authoring, and the debate\'s deep-thinking agents.' },
  { role: 'quick', label: 'Quick model', description: 'News angles and the debate\'s fast analyst passes. A smaller, cheaper model works well.' },
]

const savedSelection = computed(() => selectionData.value?.selection ?? null)
const { draft, modelLists, selectProvider, forgetProvider, testTargets } = useModelSelectionDraft(providers, savedSelection)

const providerItems = computed(() => providers.value.map(p => ({ label: p.label, value: p.id })))
const providerLabel = (id: string) => providers.value.find(p => p.id === id)?.label ?? ''

const testOutcomes = reactive<Record<string, { ok: boolean; message: string }>>({})
const testing = reactive<Record<string, boolean>>({})

async function runTest(provider: LlmProviderView, modelId?: string): Promise<ProviderTestResult> {
  const result = await $fetch<ProviderTestResult>(`/api/settings/llm/providers/${provider.id}/test`, {
    method: 'POST',
    body: modelId ? { modelId } : {},
  })
  if (result.ok && result.models.length > 0) modelLists[provider.id] = result.models
  return result
}

/** Pings every model the unsaved draft points at this provider, or only lists models when none does. */
async function testProvider(provider: LlmProviderView): Promise<void> {
  const modelIds = testTargets(provider.id)
  testing[provider.id] = true
  try {
    const targets = modelIds.length > 0 ? modelIds : [undefined]
    const runs = await Promise.all(targets.map(async modelId => ({ modelId, result: await runTest(provider, modelId) })))
    testOutcomes[provider.id] = summarizeTests(runs)
  }
  catch (err) {
    testOutcomes[provider.id] = { ok: false, message: settingsErrorMessage(err, 'Test failed.') }
  }
  finally {
    testing[provider.id] = false
  }
}

watch(() => [draft.chat.providerId, draft.quick.providerId], (ids) => {
  for (const id of ids) {
    const provider = providers.value.find(p => p.id === id)
    if (provider && !modelLists[id]) void runTest(provider).catch(() => {})
  }
}, { immediate: true })

function onCreateModel(role: ModelRole, modelId: string): void {
  draft[role].modelId = modelId
}

async function openProviderForm(provider?: LlmProviderView): Promise<void> {
  const modal = overlay.create(ProviderFormModal, { destroyOnClose: true })
  const saved = await modal.open({ provider }).result
  if (!saved) return
  // The key or base URL may have changed, so earlier results no longer apply.
  forgetProvider(saved.id)
  delete testOutcomes[saved.id]
  await refreshProviders()
  if (ROLES.some(({ role }) => draft[role].providerId === saved.id)) void runTest(saved).catch(() => {})
  toast.add({ title: provider ? 'Provider saved' : 'Provider added', color: 'success' })
}

async function removeProvider(provider: LlmProviderView): Promise<void> {
  const modal = overlay.create(ConfirmModal, { destroyOnClose: true })
  const confirmed = await modal.open({
    title: `Remove ${provider.label}?`,
    description: 'Its stored API key is deleted with it.',
    confirmLabel: 'Remove',
  }).result
  if (!confirmed) return
  try {
    await $fetch(`/api/settings/llm/providers/${provider.id}`, { method: 'DELETE' })
    forgetProvider(provider.id)
    delete testOutcomes[provider.id]
    await refreshProviders()
  }
  catch (err) {
    toast.add({ title: 'Could not remove provider', description: (err as { statusMessage?: string }).statusMessage, color: 'error' })
  }
}

const canSave = computed(() => ROLES.every(({ role }) => draft[role].providerId && draft[role].modelId.trim()))
const saving = ref(false)

async function saveSelection(): Promise<void> {
  saving.value = true
  try {
    await $fetch('/api/settings/llm/selection', {
      method: 'PUT',
      body: { chat: { ...draft.chat }, quick: { ...draft.quick } },
    })
    await refreshNuxtData('llm-selection')
    toast.add({ title: 'Models saved', color: 'success' })
  }
  catch (err) {
    toast.add({ title: 'Could not save models', description: (err as { statusMessage?: string }).statusMessage, color: 'error' })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>settings</span>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-3xl mx-auto page-pad space-y-10">
        <section class="space-y-4">
          <div class="flex items-end justify-between gap-4">
            <div>
              <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">model providers</h2>
              <p class="text-sm text-[var(--paper-2)] mt-1">API keys are encrypted with ENCRYPTION_KEY and never shown again.</p>
            </div>
            <UButton icon="i-lucide-plus" label="Add provider" @click="openProviderForm()" />
          </div>

          <div v-if="pending && !providerData" class="font-mono text-sm text-[var(--paper-3)] py-8 text-center">loading…</div>
          <UAlert v-else-if="error" color="error" variant="subtle" :description="`Failed to load providers: ${error.message}`" />
          <div v-else-if="providers.length === 0" class="surface-1 p-6 text-sm text-[var(--paper-2)]">
            No provider yet. Add one to start chatting and running research.
          </div>

          <ul v-else class="space-y-3">
            <li v-for="provider in providers" :key="provider.id" class="surface-1 p-4 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="text-[var(--paper-0)]">{{ provider.label }}</div>
                  <div class="font-mono text-xs text-[var(--paper-3)] mt-1 break-words">
                    {{ PROVIDER_KIND_META[provider.kind].label }}
                    <template v-if="provider.baseUrl"> · {{ provider.baseUrl }}</template>
                    · <span class="whitespace-nowrap">key {{ provider.apiKeyHint }}</span>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <UButton
                    label="Test connection"
                    color="neutral"
                    variant="outline"
                    size="sm"
                    :loading="testing[provider.id]"
                    @click="testProvider(provider)"
                  />
                  <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="sm" aria-label="Edit" @click="openProviderForm(provider)" />
                  <UButton icon="i-lucide-trash-2" color="error" variant="ghost" size="sm" aria-label="Remove" @click="removeProvider(provider)" />
                </div>
              </div>
              <p
                v-if="testOutcomes[provider.id] && !testing[provider.id]"
                class="font-mono text-xs break-words"
                :class="testOutcomes[provider.id]!.ok ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
              >
                {{ testOutcomes[provider.id]!.message }}
              </p>
            </li>
          </ul>
        </section>

        <!-- Reka's SelectValue renders empty on the server, so the selectors mount client-side. -->
        <ClientOnly>
          <section v-if="providers.length > 0" class="space-y-4">
            <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">models</h2>
            <div v-for="{ role, label, description } in ROLES" :key="role" class="surface-1 p-4 space-y-3">
              <div>
                <div class="text-[var(--paper-0)]">{{ label }}</div>
                <p class="text-sm text-[var(--paper-2)] mt-1">{{ description }}</p>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <UFormField label="Provider">
                  <USelect
                    v-if="providers.length > 1"
                    :model-value="draft[role].providerId"
                    :items="providerItems"
                    class="w-full"
                    @update:model-value="selectProvider(role, $event)"
                  />
                  <div v-else class="text-sm text-[var(--paper-1)] py-1.5">{{ providerLabel(draft[role].providerId) }}</div>
                </UFormField>
                <UFormField label="Model" help="Pick from the list or type any model id.">
                  <UInputMenu
                    v-model="draft[role].modelId"
                    :items="modelLists[draft[role].providerId] ?? []"
                    create-item
                    placeholder="e.g. claude-sonnet-4-6"
                    class="w-full"
                    @create="onCreateModel(role, $event)"
                  />
                </UFormField>
              </div>
            </div>
            <div class="flex justify-end">
              <UButton label="Save models" :disabled="!canSave" :loading="saving" @click="saveSelection" />
            </div>
          </section>
        </ClientOnly>
      </div>
    </main>
  </div>
</template>
