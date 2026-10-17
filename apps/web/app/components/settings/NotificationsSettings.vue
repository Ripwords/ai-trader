<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'
import { currentEndpoint, disablePush, enablePush, isIos, isStandalone, pushSupported } from '~/lib/push'
import { isValidTimeZone, type NotificationSettings } from '../../../types/notifications'
import type { PushDevice } from '../../../server/lib/push/subscriptions'
import { KIND_CHANNELS } from '../../../server/lib/notifications-core'

interface SettingsResponse {
  settings: NotificationSettings
  emailConfigured: boolean
  pushConfigured: boolean
}

const { data, pending, error, refresh } = useFetch<SettingsResponse>('/api/settings/notifications', { key: 'notification-settings' })
const { data: deviceData, refresh: refreshDevices } = useLazyFetch<{ devices: PushDevice[] }>('/api/push/subscriptions', { server: false })

const overlay = useOverlay()

const draft = reactive({ email: '', timezone: '', priceAlerts: true, reminders: true, researchRuns: true, chatReplies: true })
watch(data, (d) => {
  if (!d) return
  draft.email = d.settings.email ?? ''
  draft.timezone = d.settings.timezone
  draft.priceAlerts = d.settings.priceAlerts
  draft.reminders = d.settings.reminders
  draft.researchRuns = d.settings.researchRuns
  draft.chatReplies = d.settings.chatReplies
}, { immediate: true })

const CATEGORIES = [
  { key: 'priceAlerts', kind: 'price_alert', label: 'Price alerts', description: 'When an armed alert crosses its threshold.' },
  { key: 'reminders', kind: 'reminder', label: 'Reminders', description: 'At the time you set, from the portfolio page or the copilot.' },
  { key: 'researchRuns', kind: 'research_run', label: 'Research runs', description: 'When an agents debate started from the research page or in the background finishes, fails or is cancelled.' },
  { key: 'chatReplies', kind: 'chat_reply', label: 'Chat replies', description: 'When a copilot reply finishes while you are not looking at that chat. Covers debates the chat runs inline.' },
] as const

const channelLabel = (kind: typeof CATEGORIES[number]['kind']) =>
  KIND_CHANNELS[kind].includes('email') ? 'email + push' : 'push only'

const timezones = computed(() => {
  const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return draft.timezone && !list.includes(draft.timezone) ? [draft.timezone, ...list] : list
})

const emailValid = computed(() => draft.email.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim()))
const dirty = computed(() => {
  const s = data.value?.settings
  if (!s) return false
  return (draft.email.trim() || null) !== s.email
    || draft.timezone !== s.timezone
    || draft.priceAlerts !== s.priceAlerts
    || draft.reminders !== s.reminders
    || draft.researchRuns !== s.researchRuns
    || draft.chatReplies !== s.chatReplies
})
const canSave = computed(() => dirty.value && emailValid.value && isValidTimeZone(draft.timezone))

const saving = ref(false)
const saveMessage = ref<{ ok: boolean; text: string } | null>(null)
async function save() {
  if (!canSave.value) return
  saving.value = true
  saveMessage.value = null
  try {
    await $fetch('/api/settings/notifications', {
      method: 'PUT',
      body: { ...draft, email: draft.email.trim() || null },
    })
    await refresh()
    saveMessage.value = { ok: true, text: 'saved' }
  }
  catch (e) {
    saveMessage.value = { ok: false, text: apiErrorMessage(e, 'save failed') }
  }
  finally {
    saving.value = false
  }
}

const sendingEmail = ref(false)
const emailResult = ref<{ ok: boolean; text: string } | null>(null)
async function sendTestEmail() {
  sendingEmail.value = true
  emailResult.value = null
  try {
    const res = await $fetch<{ id: string; to: string }>('/api/notifications/test-email', { method: 'POST' })
    emailResult.value = { ok: true, text: `sent to ${res.to}` }
  }
  catch (e) {
    emailResult.value = { ok: false, text: apiErrorMessage(e, 'test email failed') }
  }
  finally {
    sendingEmail.value = false
  }
}

// Push. Everything browser-only waits for mount; permission is asked only from the click.
const supported = ref(false)
const ios = ref(false)
const standalone = ref(false)
const myEndpoint = ref<string | null>(null)
onMounted(async () => {
  supported.value = pushSupported()
  ios.value = isIos()
  standalone.value = isStandalone()
  myEndpoint.value = await currentEndpoint().catch(() => null)
})

const devices = computed(() => deviceData.value?.devices ?? [])
const thisDeviceSubscribed = computed(() =>
  !!myEndpoint.value && devices.value.some(d => myEndpoint.value!.endsWith(d.endpointTail)),
)
const showIosHint = computed(() => ios.value && !standalone.value)

const pushBusy = ref(false)
const pushResult = ref<{ ok: boolean; text: string } | null>(null)
async function onEnablePush() {
  pushBusy.value = true
  pushResult.value = null
  try {
    const { endpoint } = await enablePush()
    myEndpoint.value = endpoint
    await refreshDevices()
    pushResult.value = { ok: true, text: 'push enabled on this device' }
  }
  catch (e) {
    pushResult.value = { ok: false, text: apiErrorMessage(e, 'could not enable push') }
  }
  finally {
    pushBusy.value = false
  }
}

async function onTestPush() {
  pushBusy.value = true
  pushResult.value = null
  try {
    const res = await $fetch<{ sent: number; removed: number; errors: string[] }>('/api/push/test', { method: 'POST' })
    const parts = [`sent to ${res.sent} device${res.sent === 1 ? '' : 's'}`]
    if (res.removed) parts.push(`${res.removed} expired device${res.removed === 1 ? '' : 's'} removed`)
    if (res.errors.length) parts.push(`${res.errors.length} failed: ${res.errors[0]}`)
    pushResult.value = { ok: res.errors.length === 0, text: parts.join(' · ') }
    await refreshDevices()
  }
  catch (e) {
    pushResult.value = { ok: false, text: apiErrorMessage(e, 'test push failed') }
  }
  finally {
    pushBusy.value = false
  }
}

async function removeDevice(d: PushDevice) {
  const mine = !!myEndpoint.value && myEndpoint.value.endsWith(d.endpointTail)
  const ok = await askConfirm(
    props => overlay.create(ConfirmModal, { destroyOnClose: true }).open(props),
    { title: `remove ${deviceLabel(d)}?`, description: mine ? 'This device stops getting push notifications.' : 'That device stops getting push notifications until it is enabled again there.', confirmLabel: 'remove' },
  )
  if (!ok) return
  try {
    if (mine) {
      await disablePush()
      myEndpoint.value = null
    }
    await $fetch(`/api/push/subscriptions/${d.id}`, { method: 'DELETE' }).catch(() => {})
  }
  finally {
    await refreshDevices()
  }
}

function deviceLabel(d: PushDevice): string {
  const ua = d.userAgent ?? ''
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : d.endpointHost
  return `${os} · ${browser}`
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')
</script>

<template>
  <div class="space-y-10">
    <p class="text-sm text-[var(--paper-2)]">
      Price alerts and reminders are sent by email and as push notifications to the devices below.
      Finished research runs and chat replies are push only. Nothing is emailed until a recipient is saved.
    </p>

    <PageState v-if="pending && !data" kind="loading" message="loading notification settings…" />
    <PageState v-else-if="error" kind="error" :message="`notification settings failed to load: ${error.message}`" @retry="refresh()" />

    <template v-else-if="data">
      <section class="space-y-4">
        <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">delivery</h2>
        <div class="surface-1 p-4 space-y-4">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField label="Recipient email" :error="emailValid ? false : 'not a valid email address'" help="Leave blank to send no email.">
              <UInput v-model="draft.email" type="email" placeholder="you@example.com" autocomplete="email" class="w-full" />
            </UFormField>
            <UFormField label="Timezone" help="Reminder times are entered and shown in this zone.">
              <ClientOnly>
                <USelectMenu v-model="draft.timezone" :items="timezones" class="w-full" />
                <template #fallback>
                  <div class="text-sm text-[var(--paper-1)] py-1.5">{{ draft.timezone }}</div>
                </template>
              </ClientOnly>
            </UFormField>
          </div>
          <p v-if="!data.emailConfigured" class="font-mono text-xs text-[var(--tape-down)]">
            email is not configured on the server (RESEND_API_KEY / RESEND_DOMAIN)
          </p>
        </div>
      </section>

      <section class="space-y-4">
        <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">notify me about</h2>
        <ul class="surface-1 divide-y divide-[var(--ink-line)]">
          <li v-for="c in CATEGORIES" :key="c.key" class="p-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-[var(--paper-0)]">{{ c.label }}</span>
                <span class="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--paper-3)]">{{ channelLabel(c.kind) }}</span>
              </div>
              <p class="text-sm text-[var(--paper-2)] mt-1">{{ c.description }}</p>
            </div>
            <USwitch v-model="draft[c.key]" :aria-label="c.label" class="shrink-0 mt-1" />
          </li>
        </ul>
        <div class="flex flex-wrap items-center justify-end gap-3">
          <span v-if="saveMessage" class="font-mono text-xs" :class="saveMessage.ok ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ saveMessage.text }}</span>
          <UButton
            label="send test email"
            color="neutral"
            variant="outline"
            class="tap"
            :disabled="!data.settings.email || !data.emailConfigured || dirty"
            :title="dirty ? 'save first' : !data.settings.email ? 'save a recipient first' : undefined"
            :loading="sendingEmail"
            @click="sendTestEmail"
          />
          <UButton label="save" class="tap" :disabled="!canSave" :loading="saving" @click="save" />
        </div>
        <p v-if="emailResult" class="font-mono text-xs text-right break-words" :class="emailResult.ok ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">
          {{ emailResult.text }}
        </p>
      </section>

      <section class="space-y-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">push devices</h2>
            <p class="text-sm text-[var(--paper-2)] mt-1">Each browser or phone you enable gets a notification even when the app is closed.</p>
          </div>
          <div class="flex flex-wrap gap-2 sm:shrink-0">
            <UButton
              v-if="devices.length > 0"
              label="send test push"
              color="neutral"
              variant="outline"
              class="tap"
              :loading="pushBusy"
              @click="onTestPush"
            />
            <UButton
              v-if="!thisDeviceSubscribed"
              icon="i-lucide-bell"
              label="enable push on this device"
              class="tap"
              :disabled="!supported || !data.pushConfigured"
              :loading="pushBusy"
              @click="onEnablePush"
            />
          </div>
        </div>

        <div v-if="showIosHint" class="surface-1 p-4 text-sm text-[var(--paper-1)]">
          On iPhone and iPad, push works only from the Home Screen app: tap Share, then <span class="text-[var(--paper-0)]">Add to Home Screen</span>,
          open ai·trader from there and enable push again.
        </div>
        <p v-else-if="!supported" class="font-mono text-xs text-[var(--paper-3)]">this browser does not support push notifications</p>
        <p v-if="!data.pushConfigured" class="font-mono text-xs text-[var(--tape-down)]">push is not configured on the server (VAPID keys)</p>
        <p v-if="pushResult" class="font-mono text-xs break-words" :class="pushResult.ok ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ pushResult.text }}</p>

        <div v-if="devices.length === 0" class="surface-1 p-4 text-sm text-[var(--paper-2)]">No device subscribed yet.</div>
        <ul v-else class="surface-1 divide-y divide-[var(--ink-line)]">
          <li v-for="d in devices" :key="d.id" class="p-4 flex items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="text-[var(--paper-0)]">
                {{ deviceLabel(d) }}
                <span v-if="myEndpoint && myEndpoint.endsWith(d.endpointTail)" class="font-mono text-xs text-[var(--accent)] ml-1">this device</span>
              </div>
              <div class="font-mono text-xs text-[var(--paper-3)] mt-1">
                added {{ fmtDate(d.createdAt) }} · last delivered {{ fmtDate(d.lastSuccessAt) }}
              </div>
            </div>
            <UButton icon="i-lucide-trash-2" color="error" variant="ghost" class="tap shrink-0" :aria-label="`remove ${deviceLabel(d)}`" @click="removeDevice(d)" />
          </li>
        </ul>
      </section>

      <section class="space-y-4">
        <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">scheduler</h2>
        <div class="surface-1 p-4 space-y-2">
          <SchedulerHeartbeat />
          <p class="text-sm text-[var(--paper-2)]">Each check runs every minute on the server. If one says not running, alerts and reminders wait until the web container is back.</p>
        </div>
      </section>
    </template>
  </div>
</template>
