<script setup lang="ts">
import type { FormError } from '@nuxt/ui'
import { apiErrorMessage } from '~/lib/api-error'
import { MEMORY_MAX_CHARS, memoryContentSchema, type MemoryView } from '../../../types/memory'

const props = defineProps<{ memory?: MemoryView }>()
const emit = defineEmits<{ close: [saved: MemoryView | null] }>()

const editing = props.memory
const state = reactive({ content: editing?.content ?? '' })
const saving = ref(false)
const serverError = ref<string | null>(null)

function validate(): FormError[] {
  const parsed = memoryContentSchema.safeParse(state.content)
  return parsed.success ? [] : [{ name: 'content', message: parsed.error.issues[0]?.message ?? 'Not a valid memory.' }]
}

async function onSubmit(): Promise<void> {
  saving.value = true
  serverError.value = null
  try {
    const { memory } = editing
      ? await $fetch<{ memory: MemoryView }>(`/api/settings/memories/${editing.id}`, { method: 'PUT', body: { content: state.content } })
      : await $fetch<{ memory: MemoryView }>('/api/settings/memories', { method: 'POST', body: { content: state.content } })
    emit('close', memory)
  }
  catch (err) {
    serverError.value = apiErrorMessage(err, 'Saving failed.')
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :title="editing ? 'Edit memory' : 'Add a memory'"
    description="One fact the assistant should take as settled in every chat."
    :close="{ onClick: () => emit('close', null) }"
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <UForm id="memory-form" :state="state" :validate="validate" class="space-y-4" @submit="onSubmit">
        <UFormField
          name="content"
          label="Memory"
          :help="`${state.content.trim().length} of ${MEMORY_MAX_CHARS} characters. Say so if a risk is intentional or already known.`"
        >
          <UTextarea
            v-model="state.content"
            :rows="4"
            autoresize
            autofocus
            placeholder="My holdings are mostly USD against a MYR base. This is intentional; do not warn me about it."
            class="w-full"
          />
        </UFormField>
        <UAlert v-if="serverError" color="error" variant="subtle" :description="serverError" />
      </UForm>
    </template>
    <template #footer>
      <UButton label="cancel" color="neutral" variant="outline" @click="emit('close', null)" />
      <UButton type="submit" form="memory-form" :label="editing ? 'save' : 'add memory'" :loading="saving" />
    </template>
  </UModal>
</template>
