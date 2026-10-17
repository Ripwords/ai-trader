<script setup lang="ts">
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { validatePromptText } from '../../../server/lib/prompts/validate'
import type { PromptSaveResponse, PromptView } from '../../../types/prompts'

const props = defineProps<{ prompt: PromptView }>()
const emit = defineEmits<{ saved: [] }>()

// Literal double braces cannot sit inside a template interpolation.
const BRACES = { open: '{'.repeat(2), close: '}'.repeat(2) }

const overlay = useOverlay()
const toast = useToast()

const current = computed(() => props.prompt.override ?? props.prompt.default ?? '')
const draft = ref(current.value)
watch(current, (text) => { draft.value = text })

const check = computed(() => validatePromptText(draft.value, {
  engine: props.prompt.engine,
  placeholders: props.prompt.placeholders,
  contract: props.prompt.contract ?? undefined,
}))
const localError = computed(() => (check.value.ok ? null : check.value.error))
const warnings = computed(() => (check.value.ok ? check.value.warnings : []))
const dirty = computed(() => draft.value !== current.value)

const serverError = ref<string | null>(null)
watch(draft, () => { serverError.value = null })
const errorText = computed(() => serverError.value ?? (dirty.value ? localError.value : null))

const saving = ref(false)
const resetting = ref(false)

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { data?: { statusMessage?: string; message?: string }; statusMessage?: string }
  return e.data?.statusMessage ?? e.data?.message ?? e.statusMessage ?? fallback
}

async function save(): Promise<void> {
  saving.value = true
  serverError.value = null
  try {
    const res = await $fetch<PromptSaveResponse>(`/api/settings/prompts/${props.prompt.id}`, {
      method: 'PUT',
      body: { text: draft.value },
    })
    toast.add({ title: res.modified ? 'prompt saved' : 'matches the default, override cleared', color: 'success' })
    emit('saved')
  }
  catch (err) {
    serverError.value = errorMessage(err, 'Could not save the prompt.')
  }
  finally {
    saving.value = false
  }
}

async function reset(): Promise<void> {
  const modal = overlay.create(ConfirmModal, { destroyOnClose: true })
  const confirmed = await modal.open({
    title: `reset ${props.prompt.label}?`,
    description: 'your edited text is deleted and the built-in default is used again.',
    confirmLabel: 'reset',
  }).result
  if (!confirmed) return
  resetting.value = true
  try {
    await $fetch(`/api/settings/prompts/${props.prompt.id}`, { method: 'DELETE' })
    toast.add({ title: 'prompt reset to default', color: 'success' })
    emit('saved')
  }
  catch (err) {
    serverError.value = errorMessage(err, 'Could not reset the prompt.')
  }
  finally {
    resetting.value = false
  }
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="prompt.placeholders.length > 0" class="flex flex-col items-start gap-1.5">
      <span class="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--paper-3)]">placeholders</span>
      <div class="flex flex-wrap items-start gap-1.5">
        <UBadge
          v-for="name in prompt.placeholders"
          :key="name"
          :label="`{${name}}`"
          color="neutral"
          variant="outline"
          class="font-mono"
        />
      </div>
      <p class="text-xs text-[var(--paper-3)]">
        Use any of these. Any other brace must be doubled: write <code class="font-mono" v-text="BRACES.open" /> and <code class="font-mono" v-text="BRACES.close" />.
      </p>
    </div>

    <UTextarea
      v-model="draft"
      autoresize
      :rows="8"
      :maxrows="24"
      class="w-full"
      :ui="{ base: 'font-mono text-xs leading-relaxed' }"
      :aria-label="`${prompt.label} prompt text`"
      :aria-invalid="errorText ? 'true' : undefined"
    />

    <p v-if="errorText" class="text-sm text-[var(--tape-down)] break-words" role="alert">{{ errorText }}</p>
    <ul v-if="warnings.length > 0" class="space-y-1">
      <li v-for="w in warnings" :key="w" class="text-sm text-[var(--accent)] break-words">
        <UIcon name="i-lucide-triangle-alert" class="align-[-2px] mr-1" />{{ w }}
      </li>
    </ul>

    <div class="flex flex-wrap items-center justify-end gap-2">
      <UButton
        v-if="prompt.modified"
        label="reset to default"
        color="neutral"
        variant="outline"
        class="tap"
        :loading="resetting"
        @click="reset"
      />
      <UButton
        label="save"
        class="tap"
        :disabled="!dirty || !check.ok"
        :loading="saving"
        @click="save"
      />
    </div>
  </div>
</template>
