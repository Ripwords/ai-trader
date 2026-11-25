<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: page header with refresh + new order, tabs (active orders table; approval queue cards + recent list), ticket modal · design-system: design.md · designed-as-app */

definePageMeta({ section: 'orders' })
import { computed, watch } from 'vue'
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core'
import OrderTicketModal from '~/components/orders/OrderTicketModal.vue'
import { apiErrorMessage } from '~/lib/api-error'
import type { AccountSummary, OpenOrders } from '../../../server/lib/open-orders'
import type { Proposal } from '../../../server/lib/order-proposals'
import { ORDERS_TABS, parseOrdersTab, type OrdersTab } from '~/utils/orders-view'

useHead({ title: 'orders' })

const route = useRoute()
const router = useRouter()
const overlay = useOverlay()
const toast = useToast()

const tab = computed<OrdersTab>({
  get: () => parseOrdersTab(route.query.tab),
  set: (value) => {
    void router.replace({ query: { ...route.query, tab: value === 'active' ? undefined : value } })
  },
})

const { data: openOrders, pending: ordersPending, error: ordersError, refresh: refreshOrders } =
  useLazyFetch<OpenOrders>('/api/trade/open-orders', { server: false })
const { data: queue, pending: queuePending, error: queueError, refresh: refreshQueue } =
  useLazyFetch<{ proposals: Proposal[]; pendingCount: number }>('/api/orders/proposals', { server: false })
const { data: accountData } = useLazyFetch<AccountSummary[]>('/api/trade/accounts', { server: false, default: () => [] })

const accounts = computed(() => accountData.value ?? [])
const pendingCount = computed(() => queue.value?.pendingCount ?? 0)

const tabItems = computed(() => ORDERS_TABS.map(t => ({
  label: t.label,
  value: t.value,
  badge: t.value === 'approvals' && pendingCount.value > 0 ? { label: String(pendingCount.value), color: 'primary' as const, variant: 'subtle' as const, size: 'md' as const } : undefined,
})))

const errorText = (e: unknown) => (e ? apiErrorMessage(e, 'request failed') : null)

function refreshAll() {
  void refreshOrders()
  void refreshQueue()
}

// Poll every 30 s while the page is visible; catch up as soon as it comes back.
const visibility = useDocumentVisibility()
const { pause, resume } = useIntervalFn(refreshAll, 30_000, { immediate: false })
watch(visibility, (v) => {
  if (v === 'visible') {
    refreshAll()
    resume()
  }
  else pause()
}, { immediate: false })
onMounted(() => { if (visibility.value === 'visible') resume() })

async function newOrder() {
  const result = await overlay.create(OrderTicketModal, { destroyOnClose: true }).open({ accounts: accounts.value }).result
  if (result === 'placed') {
    toast.add({ title: 'Order placed', description: 'It shows under Active until it fills or is cancelled.' })
    tab.value = 'active'
  }
  else if (result === 'queued') {
    toast.add({ title: 'Added to the queue', description: 'Approve it under Approvals.' })
    tab.value = 'approvals'
  }
  refreshAll()
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>orders</span>
      </template>
      <template #actions>
        <UButton
          icon="i-lucide-refresh-cw"
          label="refresh"
          color="neutral"
          variant="ghost"
          size="md"
          :loading="ordersPending || queuePending"
          @click="refreshAll"
        />
        <UButton icon="i-lucide-plus" label="new order" size="md" :disabled="accounts.length === 0" @click="newOrder" />
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto page-pad space-y-6">
        <UTabs v-model="tab" :items="tabItems" :content="false" variant="link" />

        <ActiveOrders
          v-if="tab === 'active'"
          :data="openOrders"
          :pending="ordersPending || (!openOrders && !ordersError)"
          :error="errorText(ordersError)"
          @refresh="refreshAll"
        />
        <ApprovalsList
          v-else
          :proposals="queue?.proposals ?? []"
          :accounts="accounts"
          :pending="queuePending || (!queue && !queueError)"
          :error="errorText(queueError)"
          @refresh="refreshAll"
        />
      </div>
    </main>
  </div>
</template>
