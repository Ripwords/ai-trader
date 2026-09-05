<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PriceAlert, AlertKind } from '../../../server/lib/alerts-core'

// Server list is capped at 100; show newest-first. The evaluation loop runs
// server-side every 60s — this panel is just CRUD over /api/alerts.
const { data, pending, error, refresh } = useLazyFetch<{ alerts: PriceAlert[] }>('/api/alerts', {
  server: true,
  query: { status: 'all' },
})

const alerts = computed(() => data.value?.alerts ?? [])
const activeAlerts = computed(() => alerts.value.filter(a => a.status === 'active'))
const settledAlerts = computed(() => alerts.value.filter(a => a.status !== 'active').slice(0, 10))

const KIND_OPTIONS: Array<{ value: AlertKind; label: string }> = [
  { value: 'price_above', label: 'price above' },
  { value: 'price_below', label: 'price below' },
  { value: 'pct_move_day', label: 'day move %' },
]

const form = ref<{ symbol: string; kind: AlertKind; threshold: number | null; note: string }>({
  symbol: '',
  kind: 'price_above',
  threshold: null,
  note: '',
})
const creating = ref(false)
const formMessage = ref('')
const cancellingId = ref<string | null>(null)

const canCreate = computed(() =>
  form.value.symbol.trim().length > 0
  && form.value.threshold != null
  && Number.isFinite(form.value.threshold)
  && form.value.threshold > 0,
)

async function createAlert() {
  if (!canCreate.value || creating.value) return
  creating.value = true
  formMessage.value = ''
  try {
    const res = await $fetch<{ alert: PriceAlert }>('/api/alerts', {
      method: 'POST',
      body: {
        symbol: form.value.symbol.trim(),
        kind: form.value.kind,
        threshold: form.value.threshold,
        note: form.value.note.trim() || null,
      },
    })
    formMessage.value = `armed ${res.alert.symbol}`
    form.value.symbol = ''
    form.value.threshold = null
    form.value.note = ''
    await refresh()
  } catch (err) {
    formMessage.value = err instanceof Error ? err.message : 'create failed'
  } finally {
    creating.value = false
  }
}

async function cancelAlert(id: string) {
  cancellingId.value = id
  try {
    await $fetch(`/api/alerts/${id}/cancel`, { method: 'POST' })
    await refresh()
  } catch {
    /* row stays; next refresh reconciles */
  } finally {
    cancellingId.value = null
  }
}

const kindLabel = (kind: AlertKind) => KIND_OPTIONS.find(k => k.value === kind)?.label ?? kind

const fmtThreshold = (a: PriceAlert) =>
  a.kind === 'pct_move_day' ? `${a.threshold}%` : String(a.threshold)

const fmtWhen = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

const statusClass = (status: PriceAlert['status']) => {
  if (status === 'triggered') return 'text-[var(--accent)]'
  if (status === 'cancelled') return 'text-[var(--paper-3)]'
  return 'text-[var(--tape-up)]'
}
</script>

<template>
  <section class="surface-1 p-6 space-y-5">
    <div class="flex items-baseline justify-between gap-4">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">price alerts</div>
      <div class="font-mono text-xs text-[var(--paper-3)]">
        {{ activeAlerts.length }} armed · checked every 60s
      </div>
    </div>

    <!-- Create form -->
    <div class="grid grid-cols-2 md:grid-cols-[120px_150px_120px_1fr_auto] gap-2.5 items-end">
      <label class="block">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">symbol</span>
        <input
          v-model="form.symbol"
          type="text"
          placeholder="NVDA"
          class="w-full min-h-11 bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
          data-mono
          @keydown.enter="createAlert()"
        >
      </label>
      <label class="block">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">kind</span>
        <select
          v-model="form.kind"
          class="w-full min-h-11 bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
        >
          <option v-for="k in KIND_OPTIONS" :key="k.value" :value="k.value">{{ k.label }}</option>
        </select>
      </label>
      <label class="block">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">
          {{ form.kind === 'pct_move_day' ? 'move %' : 'price' }}
        </span>
        <input
          v-model.number="form.threshold"
          type="number"
          min="0"
          step="any"
          class="w-full min-h-11 bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
          data-mono
          @keydown.enter="createAlert()"
        >
      </label>
      <label class="block">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">note</span>
        <input
          v-model="form.note"
          type="text"
          placeholder="optional"
          class="w-full min-h-11 bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
          @keydown.enter="createAlert()"
        >
      </label>
      <button
        class="min-h-11 font-mono text-xs uppercase tracking-[0.16em] border px-3.5 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="canCreate && !creating
          ? 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--ink-0)]'
          : 'hairline text-[var(--paper-3)]'"
        :disabled="!canCreate || creating"
        @click="createAlert()"
      >
        {{ creating ? 'arming…' : '+ arm' }}
      </button>
    </div>
    <div v-if="formMessage" class="font-mono text-[10px] text-[var(--paper-3)] truncate">
      {{ formMessage }}
    </div>

    <!-- List -->
    <div v-if="error" class="font-mono text-sm text-[var(--tape-down)]">
      failed to load alerts: {{ error.message }}
    </div>
    <div v-else-if="pending && alerts.length === 0" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
      loading alerts…
    </div>
    <div v-else-if="alerts.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
      no alerts — arm one above or ask the copilot ("notify me when NVDA hits 150")
    </div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
            <th class="py-2 pr-4">symbol</th>
            <th class="py-2 pr-4">condition</th>
            <th class="py-2 pr-4">status</th>
            <th class="py-2 pr-4 text-right">triggered @</th>
            <th class="py-2 pr-4">note</th>
            <th class="py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in [...activeAlerts, ...settledAlerts]"
            :key="a.id"
            class="border-b hairline last:border-0"
          >
            <td class="py-2 pr-4 font-mono text-[var(--paper-0)]" data-mono>{{ a.symbol }}</td>
            <td class="py-2 pr-4 font-mono text-[var(--paper-1)]" data-mono>
              {{ kindLabel(a.kind) }} {{ fmtThreshold(a) }}
            </td>
            <td class="py-2 pr-4 font-mono text-xs" :class="statusClass(a.status)">{{ a.status }}</td>
            <td class="py-2 pr-4 text-right font-mono text-xs text-[var(--paper-2)]" data-mono>
              <template v-if="a.status === 'triggered'">
                {{ a.triggeredPrice ?? '—' }} · {{ fmtWhen(a.triggeredAt) }}
              </template>
              <template v-else>—</template>
            </td>
            <td class="py-2 pr-4 text-[var(--paper-2)] truncate max-w-[200px]">{{ a.note ?? '—' }}</td>
            <td class="py-2 text-right">
              <button
                v-if="a.status === 'active'"
                class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--tape-down)] transition-colors"
                :disabled="cancellingId === a.id"
                @click="cancelAlert(a.id)"
              >
                {{ cancellingId === a.id ? 'cancelling…' : 'cancel' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
