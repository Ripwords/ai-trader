<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import {
  PROVIDER_KINDS,
  PROVIDER_KIND_META,
  providerCreateSchema,
  providerUpdateSchema,
  type LlmProviderView,
  type ProviderKind,
} from '../../../types/llm'

const props = defineProps<{ provider?: LlmProviderView }>()
const emit = defineEmits<{ close: [saved: LlmProviderView | null] }>()

const editing = props.provider
const state = reactive({
  kind: (editing?.kind ?? 'anthropic') as ProviderKind,
  label: editing?.label ?? PROVIDER_KIND_META.anthropic.label,
  baseUrl: editing?.baseUrl ?? '',
  apiKey: '',
})
const overrideBaseUrl = ref(!!editing?.baseUrl)
const saving = ref(false)
const serverError = ref<string | null>(null)

const meta = computed(() => PROVIDER_KIND_META[state.kind])
const baseUrlRequired = computed(() => meta.value.defaultBaseUrl === null)
const showBaseUrl = computed(() => baseUrlRequired.value || overrideBaseUrl.value)
const kindItems = PROVIDER_KINDS.map(kind => ({ label: PROVIDER_KIND_META[kind].label, value: kind }))

watch(() => state.kind, (kind, previous) => {
  if (!state.label.trim() || state.label === PROVIDER_KIND_META[previous].label) {
    state.label = PROVIDER_KIND_META[kind].label
  }
})

const keyPlaceholder = computed(() => {
  if (editing?.apiKeyHint) return `${editing.apiKeyHint} stored. Leave blank to keep it.`
  return meta.value.requiresKey ? 'Paste your API key' : 'Optional'
})

function payload() {
  const baseUrl = showBaseUrl.value && state.baseUrl.trim() ? state.baseUrl.trim() : null
  const apiKey = state.apiKey.trim() || null
  if (!editing) return providerCreateSchema.safeParse({ kind: state.kind, label: state.label, baseUrl, apiKey })
  return providerUpdateSchema.safeParse({ label: state.label, baseUrl, ...(apiKey && { apiKey }) })
}

function validate(): FormError[] {
  const parsed = payload()
  if (parsed.success) return []
  return parsed.error.issues.map(issue => ({ name: String(issue.path[0] ?? 'label'), message: issue.message }))
}

async function onSubmit(): Promise<void> {
  const parsed = payload()
  if (!parsed.success) return
  saving.value = true
  serverError.value = null
  try {
    const { provider } = editing
      ? await $fetch<{ provider: LlmProviderView }>(`/api/settings/llm/providers/${editing.id}`, { method: 'PATCH', body: parsed.data })
      : await $fetch<{ provider: LlmProviderView }>('/api/settings/llm/providers', { method: 'POST', body: parsed.data })
    emit('close', provider)
  }
  catch (err) {
    serverError.value = (err as { statusMessage?: string }).statusMessage ?? 'Saving failed.'
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :title="editing ? `Edit ${editing.label}` : 'Add a model provider'"
    description="Keys are encrypted at rest and never sent back to the browser."
    :close="{ onClick: () => emit('close', null) }"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <UForm id="provider-form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
        <UFormField v-if="!editing" name="kind" label="Provider">
          <USelect v-model="state.kind" :items="kindItems" class="w-full" />
        </UFormField>
        <UFormField name="label" label="Name">
          <UInput v-model="state.label" class="w-full" />
        </UFormField>
        <UFormField name="apiKey" label="API key">
          <UInput v-model="state.apiKey" type="password" autocomplete="off" :placeholder="keyPlaceholder" class="w-full" />
        </UFormField>
        <USwitch
          v-if="!baseUrlRequired"
          v-model="overrideBaseUrl"
          label="Override base URL"
          :description="`Default: ${meta.defaultBaseUrl}`"
        />
        <UFormField v-if="showBaseUrl" name="baseUrl" label="Base URL" :hint="baseUrlRequired ? 'Required' : undefined">
          <UInput v-model="state.baseUrl" :placeholder="meta.defaultBaseUrl ?? 'http://ollama:11434/v1'" class="w-full" />
        </UFormField>
        <UAlert v-if="serverError" color="error" variant="subtle" :description="serverError" />
      </UForm>
    </template>
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="outline" @click="emit('close', null)" />
      <UButton type="submit" form="provider-form" :label="editing ? 'Save' : 'Add provider'" :loading="saving" />
    </template>
  </UModal>
</template>
