<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Item { code: string; name: string | null; group: string }

const items = ref<Item[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const newCode = ref('')

async function refresh() {
  loading.value = true
  error.value = null
  try {
    items.value = await $fetch('/api/watchlist')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'failed to load'
  } finally {
    loading.value = false
  }
}

async function add() {
  const code = newCode.value.trim()
  if (!code) return
  await $fetch('/api/watchlist/add', { method: 'POST', body: { code } })
  newCode.value = ''
  await refresh()
}

async function remove(code: string) {
  await $fetch('/api/watchlist/remove', { method: 'POST', body: { code } })
  await refresh()
}

const emit = defineEmits<{ select: [code: string] }>()

onMounted(refresh)
</script>

<template>
  <aside class="w-64 border-r flex flex-col h-full">
    <div class="px-3 py-2 border-b font-medium text-sm">Watchlist</div>
    <form class="flex gap-1 p-2 border-b" @submit.prevent="add">
      <UInput v-model="newCode" placeholder="US.NVDA" size="xs" class="flex-1" />
      <UButton size="xs" type="submit">+</UButton>
    </form>
    <div class="flex-1 overflow-y-auto">
      <div v-if="loading" class="px-3 py-2 text-xs text-gray-500">Loading…</div>
      <div v-if="error" class="px-3 py-2 text-xs text-red-500">{{ error }}</div>
      <ul>
        <li
          v-for="i in items"
          :key="i.code"
          class="group flex items-center justify-between px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer text-sm"
          @click="emit('select', i.code)"
        >
          <span>
            <span class="font-mono">{{ i.code }}</span>
            <span class="text-gray-500 ml-2">{{ i.name }}</span>
          </span>
          <UButton size="xs" variant="ghost" class="opacity-0 group-hover:opacity-100" @click.stop="remove(i.code)">×</UButton>
        </li>
      </ul>
    </div>
  </aside>
</template>
