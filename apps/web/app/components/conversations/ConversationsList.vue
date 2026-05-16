<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

interface Conversation {
  id: string
  title: string
  updatedAt: string
  pinned?: boolean
  archived?: boolean
  summary?: string
  decision_count?: number
  match?: { source: string; snippet: string }
}

const props = defineProps<{ activeId?: string | null }>()
const emit = defineEmits<{
  select: [id: string]
  new: []
  deleted: [id: string]
}>()

const conversations = ref<Conversation[]>([])
const searchResults = ref<Conversation[]>([])
const searchQuery = ref('')
const includeArchived = ref(false)
const loading = ref(false)
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

async function refresh() {
  loading.value = true
  try {
    const r = await $fetch<{ conversations: Conversation[] }>('/api/conversations', {
      query: includeArchived.value ? { archived: '1' } : {},
    })
    conversations.value = r.conversations
    await runSearch()
  } finally {
    loading.value = false
  }
}

async function remove(id: string) {
  await $fetch(`/api/conversations/${id}` as string, { method: 'DELETE' })
  emit('deleted', id)
  await refresh()
}

async function patchMetadata(id: string, body: Record<string, unknown>) {
  await $fetch(`/api/conversations/${id}/metadata` as string, { method: 'PATCH', body })
  await refresh()
}

function togglePin(id: string, pinned: boolean) {
  void patchMetadata(id, { pinned })
}

function toggleArchive(id: string, archived: boolean) {
  void patchMetadata(id, { archived })
}

defineExpose({ refresh })

watch(() => props.activeId, () => { /* no-op; parent triggers refresh */ })
watch(includeArchived, () => { void refresh() })
watch(searchQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    searchTimer = null
    void runSearch()
  }, 220)
})

onMounted(refresh)

const visibleConversations = computed(() => {
  return searchQuery.value.trim().length >= 2 ? searchResults.value : conversations.value
})

async function runSearch() {
  const q = searchQuery.value.trim()
  if (q.length < 2) {
    searchResults.value = []
    return
  }
  searching.value = true
  try {
    const r = await $fetch<{ results: Conversation[] }>('/api/conversations/search', {
      query: { q, ...(includeArchived.value ? { archived: '1' } : {}) },
    })
    searchResults.value = r.results
  } finally {
    searching.value = false
  }
}

const grouped = computed(() => {
  // Simple grouping by relative date for the sidebar
  const pinned: Conversation[] = []
  const today: Conversation[] = []
  const week: Conversation[] = []
  const older: Conversation[] = []
  const archived: Conversation[] = []
  const now = Date.now()
  for (const c of visibleConversations.value) {
    if (c.archived) {
      archived.push(c)
      continue
    }
    if (c.pinned) {
      pinned.push(c)
      continue
    }
    const age = now - new Date(c.updatedAt).getTime()
    if (age < 24 * 3600_000) today.push(c)
    else if (age < 7 * 24 * 3600_000) week.push(c)
    else older.push(c)
  }
  return { pinned, today, week, older, archived }
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
    <div class="px-5 py-3 border-b hairline space-y-2">
      <input
        v-model="searchQuery"
        type="search"
        placeholder="search chats"
        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)]"
      >
      <button
        class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        @click="includeArchived = !includeArchived"
      >
        {{ includeArchived ? 'hide archived' : 'show archived' }}
      </button>
    </div>

    <div class="overflow-y-auto scroll-hidden max-h-[40vh]">
      <div v-if="loading || searching" class="px-5 py-3 font-mono text-xs text-[var(--paper-3)]">loading…</div>
      <div v-else-if="visibleConversations.length === 0" class="px-5 py-3 font-mono text-xs text-[var(--paper-3)]">
        {{ searchQuery.trim().length >= 2 ? 'no matches' : 'no chats yet' }}
      </div>

      <template v-else>
        <ConversationGroup label="Pinned" :items="grouped.pinned" :active-id="activeId" @select="emit('select', $event)" @pin="togglePin" @archive="toggleArchive" @remove="remove" />
        <ConversationGroup label="Today" :items="grouped.today" :active-id="activeId" @select="emit('select', $event)" @pin="togglePin" @archive="toggleArchive" @remove="remove" />
        <ConversationGroup label="This week" :items="grouped.week" :active-id="activeId" @select="emit('select', $event)" @pin="togglePin" @archive="toggleArchive" @remove="remove" />
        <ConversationGroup label="Older" :items="grouped.older" :active-id="activeId" @select="emit('select', $event)" @pin="togglePin" @archive="toggleArchive" @remove="remove" />
        <ConversationGroup label="Archived" :items="grouped.archived" :active-id="activeId" @select="emit('select', $event)" @pin="togglePin" @archive="toggleArchive" @remove="remove" />
      </template>
    </div>
  </div>
</template>
