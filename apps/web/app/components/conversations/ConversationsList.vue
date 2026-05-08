<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

interface Conversation {
  id: string
  title: string
  updatedAt: string
}

const props = defineProps<{ activeId?: string | null }>()
const emit = defineEmits<{
  select: [id: string]
  new: []
  deleted: [id: string]
}>()

const conversations = ref<Conversation[]>([])
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    const r = await $fetch<{ conversations: Conversation[] }>('/api/conversations')
    conversations.value = r.conversations
  } finally {
    loading.value = false
  }
}

async function remove(id: string) {
  await $fetch(`/api/conversations/${id}`, { method: 'DELETE' })
  emit('deleted', id)
  await refresh()
}

defineExpose({ refresh })

watch(() => props.activeId, () => { /* no-op; parent triggers refresh */ })

onMounted(refresh)

const grouped = computed(() => {
  // Simple grouping by relative date for the sidebar
  const today: Conversation[] = []
  const week: Conversation[] = []
  const older: Conversation[] = []
  const now = Date.now()
  for (const c of conversations.value) {
    const age = now - new Date(c.updatedAt).getTime()
    if (age < 24 * 3600_000) today.push(c)
    else if (age < 7 * 24 * 3600_000) week.push(c)
    else older.push(c)
  }
  return { today, week, older }
})
</script>

<template>
  <div class="flex flex-col">
    <div class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div>
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">Chats</div>
        <div class="text-xl font-semibold text-[var(--paper-0)] leading-none mt-2 tracking-tight">History</div>
      </div>
      <button
        class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--accent)] hover:text-[var(--paper-0)] transition-colors"
        @click="emit('new')"
      >
        + new
      </button>
    </div>

    <div class="overflow-y-auto scroll-hidden max-h-[40vh]">
      <div v-if="loading" class="px-5 py-3 font-mono text-xs text-[var(--paper-3)]">loading…</div>
      <div v-else-if="conversations.length === 0" class="px-5 py-3 font-mono text-xs text-[var(--paper-3)]">no chats yet</div>

      <template v-else>
        <ConversationGroup label="Today" :items="grouped.today" :active-id="activeId" @select="emit('select', $event)" @remove="remove" />
        <ConversationGroup label="This week" :items="grouped.week" :active-id="activeId" @select="emit('select', $event)" @remove="remove" />
        <ConversationGroup label="Older" :items="grouped.older" :active-id="activeId" @select="emit('select', $event)" @remove="remove" />
      </template>
    </div>
  </div>
</template>
