<script setup lang="ts">
import { computed, ref } from 'vue'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import OrderTicketModal from '~/components/orders/OrderTicketModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'
import { paperAccountFor, type AccountSummary } from '../../../server/lib/open-orders'
import type { Proposal } from '../../../server/lib/order-proposals'
import { STUCK_AFTER_MS } from '../../../server/lib/order-types'
import { describeOrder, orderTypeLabel, priceSummary, proposalSettings, sessionLabel, tifLabel } from '~/utils/orders-view'

const props = defineProps<{
  proposals: Proposal[]
  accounts: AccountSummary[]
  pending: boolean
  error: string | null
}>()
const emit = defineEmits<{ refresh: [] }>()

const overlay = useOverlay()

const waiting = computed(() => props.proposals.filter(p => p.status === 'pending' || p.status === 'submitting'))
const recent = computed(() => props.proposals.filter(p => p.status !== 'pending' && p.status !== 'submitting'))

const SOURCE_LABELS: Record<Proposal['source'], string> = {
  debate: 'from a research debate',
  chat: 'from the chat',
  ticket: 'from the order ticket',
  algo: 'from an algo strategy',
}

/** A null account means the paper account for the symbol's market, picked when it is approved. */
function accountLabel(p: Proposal): string {
  if (p.accId) return props.accounts.find(a => a.acc_id === p.accId)?.label ?? (p.trdEnv === 'REAL' ? 'Live account' : 'Paper account')
  return paperAccountFor(props.accounts, p.symbol)?.label ?? 'Paper account'
}

const settings = (p: Proposal) => proposalSettings(p)
const orderLine = (p: Proposal) => {
  const s = settings(p)
  return `${orderTypeLabel(s.order_type)} · ${priceSummary(s)} · ${tifLabel(s.time_in_force)} · ${sessionLabel(s.session)}`
}

function when(ts: string | Date) {
  const d = new Date(ts)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function expiresIn(ts: string | Date): string {
  const mins = Math.round((new Date(ts).getTime() - Date.now()) / 60_000)
  if (mins <= 0) return 'expiring'
  if (mins < 60) return `expires in ${mins} min`
  return `expires in ${Math.round(mins / 60)} h`
}

const STATUS_TONE: Record<Proposal['status'], string> = {
  pending: 'text-[var(--accent)]',
  submitting: 'text-[var(--accent)]',
  submitted: 'text-[var(--tape-up)]',
  rejected: 'text-[var(--paper-3)]',
  expired: 'text-[var(--paper-3)]',
  failed: 'text-[var(--tape-down)]',
}

function techRows(p: Proposal) {
  const rows = [{ label: 'proposal id', value: p.id }]
  if (p.moomooOrderId) rows.push({ label: 'order id', value: p.moomooOrderId })
  if (p.accId) rows.push({ label: 'account id', value: p.accId })
  if (p.decisionId) rows.push({ label: 'decision id', value: p.decisionId })
  if (p.algoStrategyId) rows.push({ label: 'strategy id', value: p.algoStrategyId })
  return rows
}

const busy = ref<string | null>(null)
const actionError = ref<{ id: string; text: string } | null>(null)

async function act(p: Proposal, request: () => Promise<unknown>, failure: string) {
  actionError.value = null
  busy.value = p.id
  try {
    await request()
  }
  catch (e) {
    actionError.value = { id: p.id, text: apiErrorMessage(e, failure) }
  }
  finally {
    busy.value = null
    emit('refresh')
  }
}

async function approve(p: Proposal) {
  const live = p.trdEnv === 'REAL'
  const ok = await askConfirm(o => overlay.create(ConfirmModal, { destroyOnClose: true }).open(o), {
    title: live ? 'Approve and place a LIVE order?' : 'Approve and place this paper order?',
    description: describeOrder(settings(p), { trdEnv: p.trdEnv, accountLabel: accountLabel(p) }),
    confirmLabel: live ? 'place live order' : 'place paper order',
  })
  if (!ok) return
  await act(p, () => $fetch(`/api/orders/proposals/${p.id}/approve`, { method: 'POST' }), 'the order was not placed')
}

/** Submitting for longer than an approval can take: the approval died midway. */
function isStuck(p: Proposal): boolean {
  return p.status === 'submitting' && (!p.claimedAt || Date.now() - new Date(p.claimedAt).getTime() >= STUCK_AFTER_MS)
}

function fetchStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const { status, statusCode } = e as { status?: number; statusCode?: number }
  return status ?? statusCode
}

/**
 * Asks moomoo whether the stuck proposal's order exists and settles it. When
 * moomoo can't be reached, offers to mark it failed anyway.
 */
async function resolve(p: Proposal) {
  const url = `/api/orders/proposals/${p.id}/resolve`
  actionError.value = null
  busy.value = p.id
  try {
    await $fetch(url, { method: 'POST', body: {} })
  }
  catch (e) {
    if (fetchStatus(e) !== 502) {
      actionError.value = { id: p.id, text: apiErrorMessage(e, 'could not resolve it') }
      return
    }
    const ok = await askConfirm(o => overlay.create(ConfirmModal, { destroyOnClose: true }).open(o), {
      title: 'Mark it failed without checking?',
      description: `moomoo could not be reached to see whether this ${p.trdEnv === 'REAL' ? 'live ' : ''}order was placed (${apiErrorMessage(e, 'no answer')}). Marking it failed takes it out of the queue; the order may still exist, so check Active before queueing it again.`,
      confirmLabel: 'mark failed',
    })
    if (!ok) return
    try {
      await $fetch(url, { method: 'POST', body: { force: true } })
    }
    catch (e2) {
      actionError.value = { id: p.id, text: apiErrorMessage(e2, 'could not mark it failed') }
    }
  }
  finally {
    busy.value = null
    emit('refresh')
  }
}

function reject(p: Proposal) {
  return act(p, () => $fetch(`/api/orders/proposals/${p.id}/reject`, { method: 'POST' }), 'could not reject')
}

async function edit(p: Proposal) {
  const saved = await overlay.create(OrderTicketModal, { destroyOnClose: true })
    .open({ accounts: props.accounts, proposal: p, proposalAccountLabel: accountLabel(p) }).result
  if (saved) emit('refresh')
}
</script>

<template>
  <div class="space-y-8">
    <PageState v-if="error && proposals.length === 0" kind="error" :message="`the queue failed to load: ${error}`" @retry="emit('refresh')" />
    <PageState v-else-if="pending && proposals.length === 0" kind="loading" message="loading the queue…" />

    <section v-else class="space-y-3" aria-labelledby="waiting-title">
      <h2 id="waiting-title" class="label-eyebrow">waiting for you</h2>
      <PageState v-if="waiting.length === 0" kind="empty" message="nothing to approve. debates, the chat, algo strategies and the order ticket can queue orders here." />
      <ul v-else class="space-y-3">
        <li v-for="p in waiting" :key="p.id" class="surface-1 p-4 space-y-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-mono" :class="p.side === 'BUY' ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ p.side }}</span>
              <span class="font-mono text-[var(--paper-0)]">{{ p.qty }} {{ p.symbol }}</span>
              <span v-if="p.trdEnv === 'REAL'" class="font-mono uppercase tracking-[0.1em] text-sm text-[var(--tape-down)]">live</span>
            </div>
            <span class="text-sm text-[var(--paper-3)]">{{ isStuck(p) ? 'stuck placing' : p.status === 'submitting' ? 'placing…' : expiresIn(p.expiresAt) }}</span>
          </div>
          <p class="text-sm text-[var(--paper-1)]">{{ orderLine(p) }}</p>
          <p class="text-sm text-[var(--paper-2)]">{{ accountLabel(p) }} · {{ SOURCE_LABELS[p.source] }} · {{ when(p.createdAt) }}</p>
          <p v-if="p.rationale" class="text-sm text-[var(--paper-1)] whitespace-pre-line">{{ p.rationale }}</p>
          <p v-if="p.error" class="text-sm text-[var(--tape-down)] break-words">Last try failed: {{ p.error }}</p>
          <p v-if="actionError?.id === p.id" role="alert" class="text-sm text-[var(--tape-down)] break-words">{{ actionError.text }}</p>
          <div v-if="p.status === 'pending'" class="flex flex-wrap items-center gap-2">
            <UButton
              :label="p.trdEnv === 'REAL' ? 'approve live' : 'approve'"
              :color="p.trdEnv === 'REAL' ? 'error' : 'primary'"
              size="md"
              :loading="busy === p.id"
              :disabled="!!busy"
              @click="approve(p)"
            />
            <UButton label="edit" color="neutral" variant="outline" size="md" :disabled="!!busy" @click="edit(p)" />
            <UButton label="reject" color="neutral" variant="ghost" size="md" :disabled="!!busy" @click="reject(p)" />
          </div>
          <div v-if="isStuck(p)" class="flex flex-wrap items-center gap-2">
            <UButton
              label="check moomoo and resolve"
              color="neutral"
              variant="outline"
              size="md"
              :loading="busy === p.id"
              :disabled="!!busy"
              @click="resolve(p)"
            />
            <span class="text-sm text-[var(--paper-2)]">Marks it placed if moomoo has its order, or puts it back in the queue if not.</span>
          </div>
          <TechnicalDetails :rows="techRows(p)" />
        </li>
      </ul>
    </section>

    <section v-if="recent.length > 0" class="space-y-3" aria-labelledby="recent-title">
      <h2 id="recent-title" class="label-eyebrow">last 7 days</h2>
      <ul class="surface-1 divide-y divide-[var(--ink-line)]">
        <li v-for="p in recent" :key="p.id" class="p-4 space-y-1.5">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span class="text-sm">
              <span class="font-mono" :class="p.side === 'BUY' ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'">{{ p.side }}</span>
              <span class="font-mono text-[var(--paper-0)]"> {{ p.qty }} {{ p.symbol }}</span>
              <span class="text-[var(--paper-2)]"> · {{ orderLine(p) }}</span>
            </span>
            <span class="font-mono text-sm" :class="STATUS_TONE[p.status]">{{ p.status }}</span>
          </div>
          <p class="text-sm text-[var(--paper-2)]">{{ accountLabel(p) }} · {{ SOURCE_LABELS[p.source] }} · {{ when(p.decidedAt ?? p.createdAt) }}</p>
          <p v-if="p.error" class="text-sm text-[var(--tape-down)] break-words">{{ p.error }}</p>
          <TechnicalDetails :rows="techRows(p)" />
        </li>
      </ul>
    </section>
  </div>
</template>
