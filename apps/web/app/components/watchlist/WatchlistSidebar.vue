<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

interface Item { code: string; name: string | null; group: string }
interface OpendStatus { reachable: boolean; qot_logined: boolean; trd_logined: boolean; server_ver?: string }

const items = ref<Item[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const newCode = ref('')
const status = ref<OpendStatus>({ reachable: false, qot_logined: false, trd_logined: false })

const emit = defineEmits<{ select: [code: string] }>()

async function refresh() {
  loading.value = true
  error.value = null
  try {
    items.value = await $fetch<Item[]>('/api/watchlist')
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'failed to load'
  } finally {
    loading.value = false
  }
}

async function refreshStatus() {
  try {
    status.value = await $fetch<OpendStatus>('/api/opend-status')
  } catch {
    status.value = { reachable: false, qot_logined: false, trd_logined: false }
  }
}

const statusLabel = computed(() => {
  if (!status.value.reachable) return 'opend down'
  if (!status.value.qot_logined) return 'opend unlocked'
  return 'opend live'
})

const statusColor = computed(() => {
  if (!status.value.reachable) return 'var(--tape-down)'
  if (!status.value.qot_logined) return 'var(--accent)'
  return 'var(--tape-up)'
})

let pollHandle: ReturnType<typeof setInterval> | undefined

async function add() {
  const code = newCode.value.trim().toUpperCase()
  if (!code) return
  error.value = null
  try {
    await $fetch('/api/watchlist/add', { method: 'POST', body: { code } })
    newCode.value = ''
    await refresh()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'failed to add'
  }
}

async function remove(code: string) {
  error.value = null
  try {
    await $fetch('/api/watchlist/remove', { method: 'POST', body: { code } })
    await refresh()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'failed to remove'
  }
}

function split(code: string): [string, string] {
  const i = code.indexOf('.')
  if (i < 0) return ['', code]
  return [code.slice(0, i), code.slice(i + 1)]
}

onMounted(() => {
  refresh()
  refreshStatus()
  pollHandle = setInterval(refreshStatus, 6000)
})

onUnmounted(() => {
  if (pollHandle) clearInterval(pollHandle)
})
</script>

<template>
  <aside class="w-[300px] shrink-0 border-r hairline flex flex-col h-full bg-[var(--ink-0)] relative z-10">
    <!-- Header strip -->
    <div class="px-5 pt-5 pb-4 flex items-end justify-between border-b hairline">
      <div>
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">Watchlist</div>
        <div class="text-xl font-semibold text-[var(--paper-0)] leading-none mt-2 tracking-tight">Your tape</div>
      </div>
      <div class="font-mono text-sm text-[var(--paper-2)]">{{ items.length }}</div>
    </div>

    <!-- Add input -->
    <form class="px-5 py-4 border-b hairline flex items-center gap-2" @submit.prevent="add">
      <span class="font-mono text-base text-[var(--paper-3)] select-none">+</span>
      <input
        v-model="newCode"
        placeholder="us.nvda"
        spellcheck="false"
        autocapitalize="characters"
        class="flex-1 bg-transparent outline-none font-mono text-base text-[var(--paper-0)] placeholder:text-[var(--paper-3)] uppercase"
      />
      <button
        v-if="newCode"
        type="submit"
        class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--accent)] hover:text-[var(--paper-0)] transition-colors"
      >
        add
      </button>
    </form>

    <!-- Body -->
    <div class="flex-1 overflow-y-auto">
      <div v-if="loading" class="px-5 py-10 font-mono text-sm text-[var(--paper-3)] text-center">
        loading…
      </div>
      <div v-if="error" class="px-5 py-3 font-mono text-sm text-[var(--tape-down)]">
        {{ error }}
      </div>
      <ul v-if="!loading && !error" class="py-1">
        <li
          v-for="i in items"
          :key="i.code"
          class="group px-5 py-2.5 hover:bg-[var(--ink-2)] cursor-pointer flex items-center gap-3 transition-colors border-l-2 border-transparent hover:border-[var(--accent)]"
          @click="emit('select', i.code)"
        >
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">
                {{ split(i.code)[0] }}
              </span>
              <span class="font-mono text-base font-medium text-[var(--paper-0)]">
                {{ split(i.code)[1] }}
              </span>
            </div>
            <div class="text-sm text-[var(--paper-3)] truncate mt-0.5">
              {{ i.name || '—' }}
            </div>
          </div>
          <button
            class="opacity-0 group-hover:opacity-100 font-mono text-lg text-[var(--paper-3)] hover:text-[var(--tape-down)] transition leading-none"
            title="Remove"
            @click.stop="remove(i.code)"
          >
            ×
          </button>
        </li>
      </ul>
    </div>

    <!-- Footer — live OpenD reachability dot -->
    <div class="px-5 py-3 border-t hairline flex items-center gap-2">
      <span
        class="w-1.5 h-1.5 rounded-full"
        :class="{ 'dot-pulse': status.reachable && status.qot_logined }"
        :style="{ background: statusColor }"
      />
      <span class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-3)]">{{ statusLabel }}</span>
    </div>
  </aside>
</template>
