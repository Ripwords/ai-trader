<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Reminder } from '../../../server/lib/reminders-core'
import type { NotificationSettings } from '../../../types/notifications'
import { formatInZone, utcToZonedLocal, zonedLocalToUtc } from '../../../types/zoned-time'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'

// Times are entered and shown in the Settings → Notifications timezone, not
// the device's, so a reminder set from a phone abroad still fires when meant.
const { data, pending, error, refresh } = useLazyFetch<{ reminders: Reminder[] }>('/api/reminders', {
  server: true,
  query: { status: 'all' },
})
const { data: notif } = useLazyFetch<{ settings: NotificationSettings }>('/api/settings/notifications', { server: true })

const timezone = computed(() => notif.value?.settings.timezone ?? 'Asia/Kuala_Lumpur')
const reminders = computed(() => data.value?.reminders ?? [])
const scheduled = computed(() =>
  reminders.value.filter(r => r.status === 'scheduled').sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
)
const settled = computed(() => reminders.value.filter(r => r.status !== 'scheduled').slice(0, 10))

const overlay = useOverlay()

/** Next whole hour, at least 30 minutes out. */
function defaultWhen(tz: string): string {
  const at = new Date(Date.now() + 30 * 60_000)
  at.setUTCMinutes(0, 0, 0)
  at.setTime(at.getTime() + 60 * 60_000)
  return utcToZonedLocal(at, tz)
}

const form = ref({ when: '', message: '', symbol: '' })
watch(timezone, (tz) => {
  if (!form.value.when) form.value.when = defaultWhen(tz)
}, { immediate: true })

const creating = ref(false)
const formMessage = ref('')
const formError = ref(false)
const cancellingId = ref<string | null>(null)

const dueAt = computed(() => zonedLocalToUtc(form.value.when, timezone.value))
const canCreate = computed(() => dueAt.value !== null && form.value.message.trim().length > 0)

async function createReminder() {
  if (!canCreate.value || creating.value || !dueAt.value) return
  creating.value = true
  formMessage.value = ''
  formError.value = false
  try {
    const res = await $fetch<{ reminder: Reminder }>('/api/reminders', {
      method: 'POST',
      body: {
        dueAt: dueAt.value.toISOString(),
        message: form.value.message.trim(),
        symbol: form.value.symbol.trim() || null,
      },
    })
    formMessage.value = `scheduled for ${formatInZone(res.reminder.dueAt, timezone.value)}`
    form.value = { when: defaultWhen(timezone.value), message: '', symbol: '' }
    await refresh()
  }
  catch (err) {
    formError.value = true
    formMessage.value = apiErrorMessage(err, 'schedule failed')
  }
  finally {
    creating.value = false
  }
}

async function cancelReminder(r: Reminder) {
  const ok = await askConfirm(
    props => overlay.create(ConfirmModal, { destroyOnClose: true }).open(props),
    { title: 'cancel this reminder?', description: `"${r.message}" · ${formatInZone(r.dueAt, timezone.value)}`, confirmLabel: 'cancel reminder' },
  )
  if (!ok) return
  cancellingId.value = r.id
  try {
    await $fetch(`/api/reminders/${r.id}/cancel`, { method: 'POST' })
  }
  catch {
    /* already sent or gone; the refresh shows its real state */
  }
  finally {
    cancellingId.value = null
    await refresh()
  }
}

const statusClass = (status: Reminder['status']) => {
  if (status === 'sent') return 'text-[var(--accent)]'
  if (status === 'cancelled') return 'text-[var(--paper-3)]'
  return 'text-[var(--tape-up)]'
}

const inputClass = 'w-full min-h-11 bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors'
</script>

<template>
  <section class="surface-1 p-6 space-y-5">
    <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">reminders</div>
      <div class="font-mono text-xs text-[var(--paper-3)] sm:text-right">
        {{ scheduled.length }} scheduled · {{ timezone }} · <SchedulerHeartbeat task="reminders:dispatch" />
      </div>
    </div>

    <!-- Create form -->
    <div class="grid grid-cols-2 md:grid-cols-[200px_1fr_110px_auto] gap-2.5 items-end">
      <label class="block col-span-2 md:col-span-1">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">when</span>
        <input v-model="form.when" type="datetime-local" :class="inputClass" data-mono>
      </label>
      <label class="block col-span-2 md:col-span-1">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">message</span>
        <input
          v-model="form.message"
          type="text"
          maxlength="500"
          placeholder="check NVDA earnings"
          :class="inputClass"
          @keydown.enter="createReminder()"
        >
      </label>
      <label class="block">
        <span class="block font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">symbol</span>
        <input
          v-model="form.symbol"
          type="text"
          placeholder="optional"
          :class="inputClass"
          data-mono
          @keydown.enter="createReminder()"
        >
      </label>
      <button
        class="min-h-11 font-mono text-xs uppercase tracking-[0.16em] border px-3.5 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        :class="canCreate && !creating
          ? 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--ink-0)]'
          : 'hairline text-[var(--paper-3)]'"
        :disabled="!canCreate || creating"
        @click="createReminder()"
      >
        {{ creating ? 'scheduling…' : '+ schedule' }}
      </button>
    </div>
    <div v-if="formMessage" class="font-mono text-[10px] truncate" :class="formError ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'">
      {{ formMessage }}
    </div>

    <!-- List -->
    <div v-if="error" class="font-mono text-sm text-[var(--tape-down)]">
      failed to load reminders: {{ error.message }}
    </div>
    <div v-else-if="pending && reminders.length === 0" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
      loading reminders…
    </div>
    <div v-else-if="reminders.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
      no reminders — schedule one above or ask the copilot ("remind me to check NVDA earnings on Friday 9am")
    </div>
    <!-- Below 640px: stacked rows, so nothing scrolls sideways. -->
    <ul v-else class="sm:hidden divide-y divide-[var(--ink-line)]">
      <li v-for="r in [...scheduled, ...settled]" :key="r.id" class="py-3 flex items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <div class="text-sm text-[var(--paper-0)] break-words">{{ r.message }}</div>
          <div class="font-mono text-xs text-[var(--paper-2)]" data-mono>
            {{ formatInZone(r.dueAt, timezone) }}<template v-if="r.symbol"> · {{ r.symbol }}</template>
          </div>
          <div class="font-mono text-xs" :class="statusClass(r.status)">{{ r.status }}</div>
        </div>
        <button
          v-if="r.status === 'scheduled'"
          class="shrink-0 min-h-11 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--tape-down)] transition-colors"
          :disabled="cancellingId === r.id"
          @click="cancelReminder(r)"
        >
          {{ cancellingId === r.id ? 'cancelling…' : 'cancel' }}
        </button>
      </li>
    </ul>
    <div v-if="!error && reminders.length > 0" class="hidden sm:block overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
            <th class="py-2 pr-4">due</th>
            <th class="py-2 pr-4">message</th>
            <th class="py-2 pr-4">symbol</th>
            <th class="py-2 pr-4">status</th>
            <th class="py-2 text-right" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in [...scheduled, ...settled]" :key="r.id" class="border-b hairline last:border-0">
            <td class="py-2 pr-4 font-mono text-xs text-[var(--paper-1)] whitespace-nowrap" data-mono>{{ formatInZone(r.dueAt, timezone) }}</td>
            <td class="py-2 pr-4 text-[var(--paper-0)] max-w-[360px] truncate" :title="r.message">{{ r.message }}</td>
            <td class="py-2 pr-4 font-mono text-[var(--paper-2)]" data-mono>{{ r.symbol ?? '—' }}</td>
            <td class="py-2 pr-4 font-mono text-xs" :class="statusClass(r.status)">{{ r.status }}</td>
            <td class="py-2 text-right">
              <button
                v-if="r.status === 'scheduled'"
                class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--tape-down)] transition-colors"
                :disabled="cancellingId === r.id"
                @click="cancelReminder(r)"
              >
                {{ cancellingId === r.id ? 'cancelling…' : 'cancel' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
