<script setup lang="ts">
import { ref } from 'vue'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'
import type { OpenOrders } from '../../../server/lib/open-orders'
import { fillLabel, orderTypeLabel, priceSummary, proposalIdFromRemark, sessionLabel, tifLabel } from '~/utils/orders-view'

type ActiveOrder = OpenOrders['orders'][number]

const props = defineProps<{
  data: OpenOrders | null | undefined
  pending: boolean
  error: string | null
}>()
const emit = defineEmits<{ refresh: [] }>()

const overlay = useOverlay()
const cancelling = ref<string | null>(null)
const cancelError = ref<string | null>(null)

const labelFor = (o: ActiveOrder) => props.data?.accounts.find(a => a.acc_id === o.acc_id)?.label ?? (o.trd_env === 'REAL' ? 'Live' : 'Paper')

function created(ts: string) {
  const d = new Date(ts.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function techRows(o: ActiveOrder) {
  const rows = [
    { label: 'order id', value: o.order_id },
    { label: 'account id', value: o.acc_id },
  ]
  if (o.remark) rows.push({ label: 'remark', value: o.remark })
  return rows
}

async function cancel(o: ActiveOrder) {
  const live = o.trd_env === 'REAL'
  const ok = await askConfirm(p => overlay.create(ConfirmModal, { destroyOnClose: true }).open(p), {
    title: live ? 'Cancel a live order?' : 'Cancel this order?',
    description: `${o.side} ${o.qty} ${o.code}, ${orderTypeLabel(o.order_type)} ${priceSummary(o)}, on ${labelFor(o)}.${live ? ' This is a live order at your broker.' : ''}`,
    confirmLabel: live ? 'cancel live order' : 'cancel order',
  })
  if (!ok) return
  cancelError.value = null
  cancelling.value = o.order_id
  try {
    await $fetch('/api/trade/orders/cancel', { method: 'POST', body: { order_id: o.order_id, acc_id: o.acc_id, trd_env: o.trd_env } })
    emit('refresh')
  }
  catch (e) {
    cancelError.value = `${o.code} was not cancelled: ${apiErrorMessage(e, 'cancel failed')}`
  }
  finally {
    cancelling.value = null
  }
}
</script>

<template>
  <div class="space-y-4">
    <ul v-if="data?.failures.length" class="space-y-2">
      <li v-for="f in data.failures" :key="f.acc_id" role="alert" class="surface-1 p-3 text-sm text-[var(--accent)]">
        Could not load orders for {{ f.label }}: {{ f.message }}
      </li>
    </ul>
    <p v-if="cancelError" role="alert" class="text-sm text-[var(--tape-down)] break-words">{{ cancelError }}</p>

    <PageState v-if="error && !data" kind="error" :message="`open orders failed to load: ${error}`" @retry="emit('refresh')" />
    <PageState v-else-if="!data && pending" kind="loading" message="loading open orders…" />
    <PageState v-else-if="data && data.orders.length === 0" kind="empty" message="no working orders. orders you place or approve show here until they fill or are cancelled." />

    <div v-else-if="data" class="surface-1 table-scroll">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-[var(--paper-3)]">
            <th class="sticky left-0 bg-[var(--ink-1)] px-3 py-2 font-normal">symbol</th>
            <th class="px-3 py-2 font-normal">side</th>
            <th class="px-3 py-2 font-normal">type</th>
            <th class="px-3 py-2 font-normal text-right">filled</th>
            <th class="px-3 py-2 font-normal">price</th>
            <th class="px-3 py-2 font-normal">time in force</th>
            <th class="px-3 py-2 font-normal">session</th>
            <th class="px-3 py-2 font-normal">status</th>
            <th class="px-3 py-2 font-normal">account</th>
            <th class="px-3 py-2 font-normal">created</th>
            <th class="px-3 py-2 font-normal">from</th>
            <th class="px-3 py-2"><span class="sr-only">actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in data.orders" :key="`${o.acc_id}:${o.order_id}`" class="border-t hairline align-top">
            <td class="sticky left-0 bg-[var(--ink-1)] px-3 py-2.5 font-mono text-[var(--paper-0)] whitespace-nowrap">
              {{ o.code }}
              <TechnicalDetails :rows="techRows(o)" class="mt-1 font-sans" />
            </td>
            <td class="px-3 py-2.5 font-mono" :class="o.side === 'BUY' ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ o.side }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">{{ orderTypeLabel(o.order_type) }}</td>
            <td class="px-3 py-2.5 font-mono text-right whitespace-nowrap">{{ fillLabel(o.dealt_qty, o.qty) }}</td>
            <td class="px-3 py-2.5 font-mono whitespace-nowrap">{{ priceSummary(o) }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">{{ tifLabel(o.time_in_force) }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">{{ sessionLabel(o.session) }}</td>
            <td class="px-3 py-2.5 font-mono whitespace-nowrap">{{ o.status.toLowerCase().replaceAll('_', ' ') }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">
              {{ labelFor(o) }}
              <span v-if="o.trd_env === 'REAL'" class="ml-1 font-mono uppercase tracking-[0.1em] text-[var(--tape-down)]">real</span>
            </td>
            <td class="px-3 py-2.5 whitespace-nowrap text-[var(--paper-2)]">{{ created(o.created_at) }}</td>
            <td class="px-3 py-2.5 whitespace-nowrap">
              <NuxtLink v-if="proposalIdFromRemark(o.remark)" to="/orders?tab=approvals" class="underline underline-offset-2 hover:text-[var(--tape-up)]">approval queue</NuxtLink>
              <span v-else class="text-[var(--paper-3)]">—</span>
            </td>
            <td class="px-3 py-2.5 text-right">
              <UButton
                label="cancel"
                color="neutral"
                variant="outline"
                size="md"
                :loading="cancelling === o.order_id"
                :disabled="!!cancelling"
                @click="cancel(o)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
