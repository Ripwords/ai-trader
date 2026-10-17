<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { describeHeartbeat, SCHEDULER_TASKS, type SchedulerHeartbeat } from '../../../types/scheduler'

/**
 * When the server's scheduled tasks last ran, from /api/notifications/heartbeat.
 * With `task`: one compact line (AlertsPanel, RemindersPanel). Without: every task (Settings).
 */
const props = defineProps<{ task?: string }>()

const TASK_LABELS: Record<string, string> = {
  'alerts:evaluate': 'price alerts',
  'reminders:dispatch': 'reminders',
  'notify:send': 'email / push sender',
}

const { data, refresh } = useLazyFetch<{ heartbeat: SchedulerHeartbeat; now: string }>('/api/notifications/heartbeat', { server: false })

// "Xs ago" runs on the server's clock; device clock skew would otherwise
// read as a stale (or future) heartbeat.
const skewMs = ref(0)
watch(data, (d) => {
  if (d) skewMs.value = Date.parse(d.now) - Date.now()
})

const tick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | undefined
let pollTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  tickTimer = setInterval(() => { tick.value = Date.now() }, 5_000)
  pollTimer = setInterval(() => { void refresh() }, 30_000)
})
onBeforeUnmount(() => {
  clearInterval(tickTimer)
  clearInterval(pollTimer)
})

const rows = computed(() => {
  const hb = data.value?.heartbeat ?? {}
  const now = tick.value + skewMs.value
  const tasks = props.task ? [props.task] : [...SCHEDULER_TASKS]
  return tasks.map((t) => {
    const d = describeHeartbeat(hb[t], now)
    const text = d.stale
      ? `not running · ${d.label}`
      : d.ok ? d.label : `${d.label} · failed: ${d.error ?? 'unknown error'}`
    return { task: t, name: TASK_LABELS[t] ?? t, text, bad: d.stale || !d.ok }
  })
})
</script>

<template>
  <span
    v-if="task"
    class="font-mono text-xs"
    :class="data && rows[0]?.bad ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'"
    :title="data && rows[0]?.bad ? 'the server scheduler has not run this check recently; nothing will be sent until it does' : undefined"
  >
    {{ data ? rows[0]?.text : 'checking…' }}
  </span>
  <ul v-else class="space-y-1.5">
    <li v-for="r in rows" :key="r.task" class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 font-mono text-xs">
      <span class="w-40 shrink-0 text-[var(--paper-2)]">{{ r.name }}</span>
      <span :class="data && r.bad ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'">{{ data ? r.text : 'checking…' }}</span>
    </li>
  </ul>
</template>
