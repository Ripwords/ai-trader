<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { apiErrorMessage } from '~/lib/api-error'
import type { AccountSummary } from '../../../server/lib/open-orders'
import type { TradingSettings } from '../../../types/trading'

const { data, pending, error, refresh } = useFetch<{ settings: TradingSettings }>('/api/settings/trading', { key: 'trading-settings' })
const { data: accountData, error: accountsError } = useLazyFetch<AccountSummary[]>('/api/trade/accounts', { server: false, default: () => [] })
const accounts = computed(() => accountData.value ?? [])

const draft = reactive<{ debateProposals: boolean; accId: string | null; notional: number }>({ debateProposals: false, accId: null, notional: 1000 })
watch(data, (d) => {
  if (!d) return
  draft.debateProposals = d.settings.debateProposals
  draft.accId = d.settings.accId
  draft.notional = d.settings.notional
}, { immediate: true })

// null in the settings: the paper account for each stock's market, picked
// when the proposal is approved.
const AUTO = 'auto'
const target = computed(() => (draft.accId === null ? undefined : accounts.value.find(a => a.acc_id === draft.accId)))
const targetId = computed({
  get: () => draft.accId ?? AUTO,
  set: (id: string) => { draft.accId = id === AUTO ? null : id },
})
const accountItems = computed(() => [
  { label: 'Paper, for each stock\'s market', value: AUTO },
  ...accounts.value.map(a => ({ label: a.label, value: a.acc_id })),
])
const trdEnv = computed<'SIMULATE' | 'REAL'>(() => (draft.accId === null ? 'SIMULATE' : target.value?.trd_env ?? data.value?.settings.trdEnv ?? 'SIMULATE'))

const notionalValid = computed(() => Number.isFinite(draft.notional) && draft.notional > 0 && draft.notional <= 10_000_000)
const dirty = computed(() => {
  const s = data.value?.settings
  if (!s) return false
  return s.debateProposals !== draft.debateProposals || s.accId !== draft.accId || s.notional !== draft.notional || s.trdEnv !== trdEnv.value
})

const saving = ref(false)
const saveMessage = ref<{ ok: boolean; text: string } | null>(null)
async function save() {
  if (!dirty.value || !notionalValid.value) return
  saving.value = true
  saveMessage.value = null
  try {
    await $fetch('/api/settings/trading', {
      method: 'PUT',
      body: { debateProposals: draft.debateProposals, accId: draft.accId, trdEnv: trdEnv.value, notional: draft.notional },
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
</script>

<template>
  <div class="space-y-10">
    <p class="text-sm text-[var(--paper-2)]">
      Nothing here places an order. Proposals wait on the Orders page under Approvals until you approve, edit or reject them,
      and expire after 24 hours.
    </p>

    <PageState v-if="pending && !data" kind="loading" message="loading trading settings…" />
    <PageState v-else-if="error" kind="error" :message="`trading settings failed to load: ${error.message}`" @retry="refresh()" />

    <section v-else-if="data" class="space-y-4">
      <h2 class="font-mono text-sm uppercase tracking-[0.18em] text-[var(--paper-3)]">debate proposals</h2>
      <div class="surface-1 p-4 space-y-5">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <span class="text-[var(--paper-0)]">Queue an order after a debate</span>
            <p class="text-sm text-[var(--paper-2)] mt-1">
              When a research debate rates a stock buy or strong buy, queue a limit buy at the last price for the amount below.
              Sell queues the whole position, reduce queues half. Hold queues nothing.
            </p>
          </div>
          <USwitch v-model="draft.debateProposals" aria-label="Queue an order after a debate" class="shrink-0 mt-1" />
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField v-if="accounts.length > 0" label="Account" :help="trdEnv === 'REAL' ? 'Live account: approving trades real money.' : 'Paper account.'">
            <USelect v-model="targetId" :items="accountItems" size="md" class="w-full" />
          </UFormField>
          <div v-else class="text-sm space-y-1">
            <span class="text-[var(--paper-3)]">Account</span>
            <p class="text-[var(--paper-0)]">{{ target?.label ?? 'Paper, for each stock\'s market' }}</p>
            <p v-if="accountsError" class="text-[var(--paper-2)]">Accounts could not be loaded, so the account cannot be changed now.</p>
          </div>
          <UFormField label="Amount per buy" help="In the stock's own currency. The share count is this divided by the last price, rounded down." :error="notionalValid ? false : 'enter an amount above 0'">
            <UInput v-model.number="draft.notional" type="number" min="1" step="100" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
          </UFormField>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-3">
        <span v-if="saveMessage" class="text-sm" :class="saveMessage.ok ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ saveMessage.text }}</span>
        <UButton label="save" size="md" class="tap" :disabled="!dirty || !notionalValid" :loading="saving" @click="save" />
      </div>
    </section>
  </div>
</template>
