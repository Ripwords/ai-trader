<script setup lang="ts">
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import MemoryFormModal from '~/components/settings/MemoryFormModal.vue'
import { apiErrorMessage } from '~/lib/api-error'
import { askConfirm } from '~/lib/confirm'
import type { MemoryListResponse, MemorySource, MemoryView } from '../../../types/memory'

const { data, pending, error, refresh } = useFetch<MemoryListResponse>('/api/settings/memories', { key: 'chat-memories' })

const overlay = useOverlay()
const toast = useToast()

const memories = computed(() => data.value?.memories ?? [])
const full = computed(() => !!data.value && memories.value.length >= data.value.limit)

const SOURCE_LABEL: Record<MemorySource, string> = {
  manual: 'added by you',
  auto: 'learned from chat',
}

async function openForm(memory?: MemoryView): Promise<void> {
  const saved = await overlay.create(MemoryFormModal, { destroyOnClose: true }).open({ memory }).result
  if (!saved) return
  await refresh()
  toast.add({ title: memory ? 'memory saved' : 'memory added', color: 'success' })
}

async function remove(memory: MemoryView): Promise<void> {
  const ok = await askConfirm(
    props => overlay.create(ConfirmModal, { destroyOnClose: true }).open(props),
    { title: 'delete this memory?', description: `"${memory.content}" The assistant stops taking it as settled from the next message.`, confirmLabel: 'delete' },
  )
  if (!ok) return
  try {
    await $fetch(`/api/settings/memories/${memory.id}`, { method: 'DELETE' })
  }
  catch (err) {
    toast.add({ title: 'could not delete memory', description: apiErrorMessage(err, 'Deleting failed.'), color: 'error' })
  }
  finally {
    await refresh()
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <p class="text-sm text-[var(--paper-2)]">
        What the assistant takes as settled in every chat. It adds to this list when you state a standing preference, an intentional decision, a risk you already accept, a constraint or a goal.
        A risk recorded here as intentional is not raised again unless it has changed or you ask.
      </p>
      <UButton
        icon="i-lucide-plus"
        label="add memory"
        class="tap shrink-0 self-start"
        :disabled="full"
        :title="full ? 'memory is full; delete or edit one first' : undefined"
        @click="openForm()"
      />
    </div>

    <PageState v-if="pending && !data" kind="loading" message="loading memories…" />
    <PageState v-else-if="error" kind="error" :message="`memories failed to load: ${error.message}`" @retry="refresh()" />

    <template v-else-if="data">
      <div v-if="memories.length === 0" class="surface-1 p-6 text-sm text-[var(--paper-2)]">
        Nothing remembered yet. Add a fact here, or tell the assistant in chat, for example "my USD exposure is intentional".
      </div>

      <ul v-else class="surface-1 divide-y divide-[var(--ink-line)]">
        <li v-for="m in memories" :key="m.id" class="p-4 flex items-start justify-between gap-4">
          <div class="min-w-0 flex-1">
            <p class="text-[var(--paper-0)] break-words">{{ m.content }}</p>
            <p class="text-sm text-[var(--paper-3)] mt-1">{{ SOURCE_LABEL[m.source] }}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" class="tap" aria-label="edit memory" @click="openForm(m)" />
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" class="tap" aria-label="delete memory" @click="remove(m)" />
          </div>
        </li>
      </ul>

      <p class="text-sm text-[var(--paper-3)]">{{ memories.length }} of {{ data.limit }} saved</p>
    </template>
  </div>
</template>
