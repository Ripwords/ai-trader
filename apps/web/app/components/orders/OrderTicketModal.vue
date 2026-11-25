<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'
import {
  allowedOrderTypes,
  allowedSessions,
  allowedTimeInForce,
  orderFieldsFor,
  orderRuleProblem,
  pickOrderFields,
  type OrderSession,
  type OrderSettings,
  type OrderType,
  type TimeInForce,
  type TrailType,
} from '../../../server/lib/order-types'
import type { AccountSummary } from '../../../server/lib/open-orders'
import type { Proposal } from '../../../server/lib/order-proposals'
import { describeOrder, orderBody, orderTypeLabel, sessionLabel, tifLabel } from '~/utils/orders-view'

// New order (Place now / Add to queue) or editing a queued proposal. Fields
// the chosen account or type cannot use are hidden; the api re-checks all of it.

const props = defineProps<{
  accounts: AccountSummary[]
  /** Editing this queued proposal; its account, symbol and side stay fixed. */
  proposal?: Proposal
  /** The label of the proposal's account, when editing. */
  proposalAccountLabel?: string
}>()

const emit = defineEmits<{ close: [result: 'placed' | 'queued' | 'saved' | null] }>()

const overlay = useOverlay()
const editing = computed(() => !!props.proposal)

const firstPaper = props.accounts.find(a => a.trd_env === 'SIMULATE') ?? props.accounts[0]
const form = reactive({
  accId: props.proposal?.accId ?? firstPaper?.acc_id ?? '',
  code: props.proposal?.symbol ?? '',
  side: (props.proposal?.side ?? 'BUY') as 'BUY' | 'SELL',
  qty: props.proposal?.qty ?? 1,
  orderType: (props.proposal?.orderType ?? 'NORMAL') as OrderType,
  price: props.proposal?.price ?? undefined as number | undefined,
  triggerPrice: props.proposal?.triggerPrice ?? undefined as number | undefined,
  trailType: (props.proposal?.trailType ?? 'RATIO') as TrailType,
  trailValue: props.proposal?.trailValue ?? undefined as number | undefined,
  trailSpread: props.proposal?.trailSpread ?? undefined as number | undefined,
  timeInForce: (props.proposal?.timeInForce ?? 'DAY') as TimeInForce,
  session: (props.proposal?.session ?? 'RTH') as OrderSession,
})

const account = computed(() => props.accounts.find(a => a.acc_id === form.accId))
const trdEnv = computed(() => props.proposal?.trdEnv ?? account.value?.trd_env ?? 'SIMULATE')
const accountLabel = computed(() => props.proposalAccountLabel ?? account.value?.label ?? 'paper account')
const isLive = computed(() => trdEnv.value === 'REAL')

const typeOptions = computed(() => allowedOrderTypes(trdEnv.value))
const tifOptions = computed(() => allowedTimeInForce(trdEnv.value))
const sessionOptions = computed(() => allowedSessions({ trdEnv: trdEnv.value, orderType: form.orderType, code: form.code.trim() }))
const fields = computed(() => orderFieldsFor(form.orderType))

// Keep every choice inside what the account and type allow.
watch([typeOptions, tifOptions, sessionOptions], () => {
  if (!typeOptions.value.includes(form.orderType)) form.orderType = typeOptions.value[0] ?? 'NORMAL'
  if (!tifOptions.value.includes(form.timeInForce)) form.timeInForce = 'DAY'
  if (!sessionOptions.value.includes(form.session)) form.session = 'RTH'
}, { immediate: true })

const accountItems = computed(() => props.accounts.map(a => ({ label: a.label, value: a.acc_id })))
const typeItems = computed(() => typeOptions.value.map(t => ({ label: orderTypeLabel(t), value: t })))
const tifItems = computed(() => tifOptions.value.map(t => ({ label: tifLabel(t), value: t })))
const sessionItems = computed(() => sessionOptions.value.map(s => ({ label: sessionLabel(s), value: s })))
const sideItems = [{ label: 'buy', value: 'BUY' }, { label: 'sell', value: 'SELL' }]
const trailTypeItems = [{ label: 'percent', value: 'RATIO' }, { label: 'price amount', value: 'AMOUNT' }]

const num = (v: number | undefined | null | string) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const order = computed<OrderSettings>(() => pickOrderFields({
  code: form.code.trim().toUpperCase(),
  side: form.side,
  qty: Number(form.qty),
  order_type: form.orderType,
  price: num(form.price),
  trigger_price: num(form.triggerPrice),
  trail_type: form.trailType,
  trail_value: num(form.trailValue),
  trail_spread: num(form.trailSpread),
  time_in_force: form.timeInForce,
  session: form.session,
}))

const problem = computed(() => {
  if (!editing.value && !account.value) return 'pick an account'
  if (!/^[A-Z]{2}\.[A-Z0-9.]+$/.test(order.value.code)) return 'symbol needs a market prefix, like US.NVDA or HK.00700'
  const rule = orderRuleProblem({ ...order.value, trd_env: trdEnv.value })
  // The shared rule text names the type by its API name; show the label instead.
  const type = order.value.order_type ?? 'NORMAL'
  return rule?.replaceAll(type, orderTypeLabel(type)) ?? null
})

const busy = ref<'place' | 'queue' | 'save' | null>(null)
const error = ref<string | null>(null)

async function confirmLive(title: string, confirmLabel: string): Promise<boolean> {
  if (!isLive.value) return true
  return askConfirm(p => overlay.create(ConfirmModal, { destroyOnClose: true }).open(p), {
    title,
    description: describeOrder(order.value, { trdEnv: trdEnv.value, accountLabel: accountLabel.value }),
    confirmLabel,
  })
}

async function run(kind: 'place' | 'queue' | 'save', request: () => Promise<unknown>) {
  if (problem.value) return
  error.value = null
  busy.value = kind
  try {
    await request()
    emit('close', kind === 'place' ? 'placed' : kind === 'queue' ? 'queued' : 'saved')
  }
  catch (e) {
    error.value = apiErrorMessage(e, kind === 'place' ? 'the order was not placed' : 'could not save')
  }
  finally {
    busy.value = null
  }
}

const newOrderBody = () => ({
  ...orderBody(order.value),
  accId: form.accId,
  trdEnv: trdEnv.value,
  symbol: order.value.code,
  side: order.value.side,
})

async function placeNow() {
  if (!(await confirmLive('Place a live order now?', 'place live order'))) return
  await run('place', () => $fetch('/api/trade/orders/place', { method: 'POST', body: newOrderBody() }))
}

function addToQueue() {
  return run('queue', () => $fetch('/api/orders/proposals', { method: 'POST', body: newOrderBody() }))
}

function saveEdit() {
  const id = props.proposal?.id
  if (!id) return
  return run('save', () => $fetch(`/api/orders/proposals/${id}`, { method: 'PATCH', body: orderBody(order.value) }))
}
</script>

<template>
  <UModal
    :title="editing ? 'Edit queued order' : 'New order'"
    :description="editing ? 'Changes apply before you approve it. Account, symbol and side stay as proposed.' : 'Place it now, or add it to the queue to approve later.'"
    :close="{ onClick: () => emit('close', null) }"
    :ui="{ footer: 'justify-end flex-wrap' }"
  >
    <template #body>
      <form class="space-y-4" @submit.prevent>
        <div v-if="editing || accounts.length <= 1" class="flex flex-wrap items-baseline gap-2 text-sm">
          <span class="text-[var(--paper-3)]">account</span>
          <span class="text-[var(--paper-0)]">{{ accountLabel }}</span>
          <span v-if="isLive" class="live-badge">live</span>
        </div>
        <UFormField v-else label="Account">
          <USelect v-model="form.accId" :items="accountItems" size="md" class="w-full" />
        </UFormField>
        <p v-if="isLive" class="text-sm text-[var(--tape-down)]">This account trades real money.</p>

        <div class="grid grid-cols-2 gap-3">
          <UFormField label="Symbol" class="col-span-2 sm:col-span-1">
            <UInput v-model="form.code" :disabled="editing" placeholder="US.NVDA" size="md" class="w-full" :ui="{ base: 'font-mono uppercase' }" />
          </UFormField>
          <UFormField label="Side">
            <USelect v-model="form.side" :items="sideItems" :disabled="editing" size="md" class="w-full" />
          </UFormField>
          <UFormField label="Quantity">
            <UInput v-model.number="form.qty" type="number" min="1" step="1" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
          </UFormField>
          <UFormField label="Order type" class="col-span-2 sm:col-span-1">
            <USelect v-model="form.orderType" :items="typeItems" size="md" class="w-full" />
          </UFormField>
          <UFormField v-if="fields.trigger" label="Trigger price">
            <UInput v-model.number="form.triggerPrice" type="number" min="0" step="0.01" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
          </UFormField>
          <UFormField v-if="fields.price" :label="form.orderType === 'NORMAL' ? 'Limit price' : 'Limit price after trigger'">
            <UInput v-model.number="form.price" type="number" min="0" step="0.01" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
          </UFormField>
          <template v-if="fields.trail">
            <UFormField label="Trail by">
              <USelect v-model="form.trailType" :items="trailTypeItems" size="md" class="w-full" />
            </UFormField>
            <UFormField :label="form.trailType === 'RATIO' ? 'Trail (%)' : 'Trail (price)'">
              <UInput v-model.number="form.trailValue" type="number" min="0" step="0.01" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
            </UFormField>
          </template>
          <UFormField v-if="fields.spread" label="Limit spread" help="How far the limit sits from the trailed stop.">
            <UInput v-model.number="form.trailSpread" type="number" min="0" step="0.01" size="md" class="w-full" :ui="{ base: 'font-mono' }" />
          </UFormField>
          <UFormField v-if="tifOptions.length > 1" label="Time in force">
            <USelect v-model="form.timeInForce" :items="tifItems" size="md" class="w-full" />
          </UFormField>
          <UFormField v-if="sessionOptions.length > 1" label="Session">
            <USelect v-model="form.session" :items="sessionItems" size="md" class="w-full" />
          </UFormField>
        </div>

        <p v-if="tifOptions.length === 1 || sessionOptions.length === 1" class="text-sm text-[var(--paper-2)]">
          <template v-if="tifOptions.length === 1">Day order</template><template v-if="tifOptions.length === 1 && sessionOptions.length === 1">, </template><template v-if="sessionOptions.length === 1">regular hours</template>.
          <template v-if="!isLive">Paper accounts take limit and market day orders only.</template>
        </p>

        <p v-if="problem && form.code.trim()" class="text-sm text-[var(--paper-2)]">{{ problem }}</p>
        <p v-if="error" role="alert" class="text-sm text-[var(--tape-down)] break-words">{{ error }}</p>
      </form>
    </template>

    <template #footer>
      <UButton label="cancel" color="neutral" variant="outline" size="md" @click="emit('close', null)" />
      <template v-if="editing">
        <UButton label="save" size="md" :disabled="!!problem || !!busy" :loading="busy === 'save'" @click="saveEdit" />
      </template>
      <template v-else>
        <UButton label="add to queue" color="neutral" variant="outline" size="md" :disabled="!!problem || !!busy" :loading="busy === 'queue'" @click="addToQueue" />
        <UButton
          :label="isLive ? 'place live order now' : 'place now'"
          :color="isLive ? 'error' : 'primary'"
          size="md"
          :disabled="!!problem || !!busy"
          :loading="busy === 'place'"
          @click="placeNow"
        />
      </template>
    </template>
  </UModal>
</template>

<style scoped>
.live-badge {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--tape-down);
  border: 1px solid var(--tape-down);
  border-radius: 4px;
  padding: 0 0.35rem;
}
</style>
