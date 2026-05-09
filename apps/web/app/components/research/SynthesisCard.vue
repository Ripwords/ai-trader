<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { Decision, DecisionAction } from '../../../types/research'

interface PlaceOrderResponse {
  ok: true
  order: {
    order_id: string
    code: string
    side: 'BUY' | 'SELL'
    qty: number
    price: number
    status: string
    trd_env: 'SIMULATE' | 'REAL'
    acc_id: string
  }
}

interface PaperAccount {
  acc_id: string
  acc_type: string
  acc_role: string | null
  markets: string[]
}

const props = defineProps<{ decisions: Decision[] }>()
const toast = useToast()
const inFlight = reactive<Set<string>>(new Set())
const paperAccounts = ref<PaperAccount[]>([])
const selectedAccountId = ref<string | undefined>(undefined)

onMounted(async () => {
  try {
    const r = await $fetch<{ accounts: PaperAccount[] }>('/api/research/paper-accounts')
    paperAccounts.value = r.accounts
    if (r.accounts.length === 1) selectedAccountId.value = r.accounts[0]?.acc_id
  } catch (err) {
    console.error('[SynthesisCard] paper-accounts fetch failed', err)
  }
})

const accountOptions = computed(() =>
  paperAccounts.value.map(a => ({
    value: a.acc_id,
    label: `${a.acc_type} · ${a.acc_id}`,
  })),
)
const showAccountPicker = computed(() => paperAccounts.value.length > 1)

function actionColor(action: DecisionAction): 'success' | 'error' | 'warning' | 'neutral' {
  switch (action) {
    case 'buy':
    case 'cover':
      return 'success'
    case 'sell':
    case 'short':
      return 'error'
    case 'hold':
      return 'neutral'
    default:
      return 'warning'
  }
}

function pct(n: number): string {
  const v = n <= 1 ? n * 100 : n
  return `${Math.max(0, Math.min(100, Math.round(v)))}%`
}

function paperSide(action: DecisionAction): 'BUY' | 'SELL' | null {
  switch (action) {
    case 'buy':
    case 'cover':
      return 'BUY'
    case 'sell':
    case 'short':
      return 'SELL'
    default:
      return null
  }
}

async function sendToPaper(d: Decision): Promise<void> {
  if (inFlight.has(d.symbol)) return
  const side = paperSide(d.action)
  if (!side) return
  inFlight.add(d.symbol)
  try {
    const res = await $fetch<PlaceOrderResponse>('/api/research/send-to-paper', {
      method: 'POST',
      body: {
        symbol: d.symbol,
        action: d.action,
        quantity: d.quantity,
        acc_id: selectedAccountId.value,
      },
    })
    toast.add({
      title: 'Paper order placed',
      description: `${res.order.side} ${res.order.qty} ${res.order.code}`,
      color: 'success',
      icon: 'i-lucide-check-circle',
    })
  } catch (err: unknown) {
    const message = extractErrorMessage(err)
    toast.add({
      title: 'Paper order failed',
      description: message,
      color: 'error',
      icon: 'i-lucide-alert-triangle',
    })
  } finally {
    inFlight.delete(d.symbol)
  }
}

function extractErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { data?: { statusMessage?: string; message?: string }; statusMessage?: string; message?: string }
    return (
      e.data?.statusMessage
      || e.data?.message
      || e.statusMessage
      || e.message
      || 'unknown error'
    )
  }
  return String(err)
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between gap-4">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">Synthesis · decisions</div>
      <div class="flex items-baseline gap-3">
        <USelect
          v-if="showAccountPicker"
          v-model="selectedAccountId"
          :items="accountOptions"
          size="xs"
          placeholder="paper acct"
          class="font-mono text-xs"
        />
        <div class="font-mono text-xs text-[var(--paper-3)]" data-mono>{{ props.decisions.length }} symbols</div>
      </div>
    </header>

    <div v-if="props.decisions.length === 0" class="px-5 py-6 text-center font-mono text-sm text-[var(--paper-3)]">
      no decisions returned
    </div>

    <div v-else>
      <div class="grid grid-cols-[1fr_0.7fr_0.6fr_0.7fr_2.2fr_auto] gap-3 px-5 py-3 font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-3)] border-b hairline">
        <div>symbol</div>
        <div>action</div>
        <div class="text-right">qty</div>
        <div class="text-right">conf</div>
        <div>reasoning</div>
        <div class="text-right">paper</div>
      </div>
      <div
        v-for="(d, i) in props.decisions"
        :key="i"
        class="grid grid-cols-[1fr_0.7fr_0.6fr_0.7fr_2.2fr_auto] gap-3 px-5 py-3 border-b hairline last:border-b-0 hover:bg-[var(--ink-2)] transition-colors items-center"
      >
        <div class="font-mono text-base text-[var(--paper-0)]" data-mono>{{ d.symbol }}</div>
        <div>
          <UBadge :color="actionColor(d.action)" variant="soft" class="font-mono text-xs uppercase tracking-[0.18em]">
            {{ d.action }}
          </UBadge>
        </div>
        <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ d.quantity }}</div>
        <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ pct(d.confidence) }}</div>
        <div class="text-sm text-[var(--paper-2)] leading-snug line-clamp-3">{{ d.reasoning }}</div>
        <div class="text-right">
          <UButton
            v-if="paperSide(d.action)"
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-send"
            :loading="inFlight.has(d.symbol)"
            :disabled="inFlight.has(d.symbol)"
            class="font-mono text-xs uppercase tracking-[0.15em]"
            @click="sendToPaper(d)"
          >
            Send to paper
          </UButton>
          <span v-else class="font-mono text-xs text-[var(--paper-3)]">—</span>
        </div>
      </div>
    </div>
  </div>
</template>
