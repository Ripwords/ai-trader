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

const props = defineProps<{
  decisions: Decision[] | null
  symbol: string | null
  running: boolean
  synthesizing: boolean
  signalCount: number
  error: string | null
}>()

const emit = defineEmits<{
  synthesize: []
}>()

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
    console.error('[VerdictPanel] paper-accounts fetch failed', err)
  }
})

const accountOptions = computed(() =>
  paperAccounts.value.map(a => ({
    value: a.acc_id,
    label: `${a.acc_type} · ${a.acc_id}`,
  })),
)
const showAccountPicker = computed(() => paperAccounts.value.length > 1)

type State = 'empty' | 'running' | 'synthesizing' | 'awaiting' | 'ready' | 'error'

const state = computed<State>(() => {
  if (props.error) return 'error'
  if (props.synthesizing) return 'synthesizing'
  if (props.decisions && props.decisions.length > 0) return 'ready'
  if (props.running) return 'running'
  if (props.signalCount > 0) return 'awaiting'
  return 'empty'
})

const canSynthesize = computed(() => props.signalCount > 0 && !props.synthesizing)

const synthLabel = computed(() => {
  if (props.synthesizing) return 'synthesizing…'
  if (state.value === 'ready') return 're-synthesize ↻'
  return 'synthesize →'
})

const headRight = computed(() => {
  if (props.decisions && props.decisions.length > 1) {
    return `${props.decisions.length} symbols`
  }
  return props.symbol ?? '—'
})

const subhead = computed(() => {
  switch (state.value) {
    case 'running': return 'streaming'
    case 'synthesizing': return 'fanning'
    case 'awaiting': return 'ready'
    case 'error': return 'error'
    default: return ''
  }
})

function stampAction(action: DecisionAction): string {
  return action.toUpperCase()
}

function tone(action: DecisionAction): 'up' | 'down' | 'neutral' {
  switch (action) {
    case 'buy':
    case 'cover':
      return 'up'
    case 'sell':
    case 'short':
      return 'down'
    default:
      return 'neutral'
  }
}

function pct(n: number): number {
  const v = n <= 1 ? n * 100 : n
  return Math.max(0, Math.min(100, Math.round(v)))
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
  if (!paperSide(d.action)) return
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
    toast.add({
      title: 'Paper order failed',
      description: extractErrorMessage(err),
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
  <aside class="verdict surface-1">
    <!-- Header: eyebrow + symbol/count -->
    <header class="verdict__head">
      <div class="verdict__eyebrow">
        <span class="dot" :data-state="state" />
        <span>verdict</span>
        <span v-if="subhead" class="verdict__sub">· {{ subhead }}</span>
      </div>
      <div class="verdict__sym" data-mono>{{ headRight }}</div>
    </header>

    <!-- Body: state machine -->
    <div class="verdict__body">
      <!-- empty: nothing run yet -->
      <div v-if="state === 'empty'" class="ghost">
        <div class="ghost__mark">⌗</div>
        <p>verdict will land here once the desk weighs in.</p>
      </div>

      <!-- research streaming -->
      <div v-else-if="state === 'running'" class="ghost ghost--live">
        <div class="ring"><span /><span /><span /></div>
        <p>deliberating · waiting on {{ signalCount }} of the desk so far.</p>
      </div>

      <!-- synthesis call in flight -->
      <div v-else-if="state === 'synthesizing'" class="ghost ghost--live">
        <div class="ring"><span /><span /><span /></div>
        <p>fanning {{ signalCount }} signal{{ signalCount === 1 ? '' : 's' }} into a verdict…</p>
      </div>

      <!-- error state -->
      <div v-else-if="state === 'error'" class="ghost ghost--error">
        <div class="ghost__mark">!</div>
        <p>{{ error }}</p>
      </div>

      <!-- signals returned but synthesis hasn't run -->
      <div v-else-if="state === 'awaiting'" class="ghost ghost--ready">
        <p>{{ signalCount }} signal{{ signalCount === 1 ? '' : 's' }} on the wire. press synthesize to call it.</p>
      </div>

      <!-- decisions ready -->
      <div v-else-if="state === 'ready' && decisions" class="verdict__list">
        <USelect
          v-if="showAccountPicker"
          v-model="selectedAccountId"
          :items="accountOptions"
          size="xs"
          placeholder="paper acct"
          class="font-mono text-xs mb-2"
        />
        <article
          v-for="(d, i) in decisions"
          :key="d.symbol"
          class="card"
          :data-tone="tone(d.action)"
          :style="{ '--stagger': `${i * 70}ms` }"
        >
          <!-- multi-symbol mode shows symbol per card; single-symbol mode is in header -->
          <div v-if="decisions.length > 1" class="card__sym" data-mono>{{ d.symbol }}</div>

          <!-- The stamped trade-ticket: hairlines flank the action verdict, qty hangs below -->
          <div class="ticket" :data-tone="tone(d.action)">
            <span class="ticket__rule" />
            <div class="ticket__action" data-mono>{{ stampAction(d.action) }}</div>
            <span class="ticket__rule" />
            <div class="ticket__qty">
              <span class="ticket__qty-num" data-mono>{{ d.quantity }}</span>
              <span class="ticket__qty-unit">sh</span>
            </div>
          </div>

          <!-- Confidence read-out -->
          <div class="conf">
            <div class="conf__head">
              <span class="eyebrow">confidence</span>
              <span class="conf__num" :data-tone="tone(d.action)" data-mono>{{ pct(d.confidence) }}%</span>
            </div>
            <div class="conf__bar">
              <div class="conf__fill" :data-tone="tone(d.action)" :style="{ width: pct(d.confidence) + '%' }" />
            </div>
          </div>

          <!-- Reasoning -->
          <div class="reasoning">
            <div class="reasoning__label eyebrow">thesis</div>
            <p>{{ d.reasoning }}</p>
          </div>

          <!-- Action: send to paper or hold tag -->
          <button
            v-if="paperSide(d.action)"
            type="button"
            class="send"
            :disabled="inFlight.has(d.symbol)"
            @click="sendToPaper(d)"
          >
            <span v-if="inFlight.has(d.symbol)" class="spinner" aria-hidden="true" />
            <span>{{ inFlight.has(d.symbol) ? 'sending…' : 'send to paper →' }}</span>
          </button>
          <div v-else class="hold-tag">
            <span>hold</span><span>no order placed</span>
          </div>
        </article>
      </div>
    </div>

    <!-- Footer: synthesize / re-synthesize CTA -->
    <footer class="verdict__foot">
      <button
        type="button"
        class="cta"
        :disabled="!canSynthesize"
        @click="emit('synthesize')"
      >
        <span v-if="synthesizing" class="spinner spinner--ink" aria-hidden="true" />
        <span>{{ synthLabel }}</span>
      </button>
      <p v-if="!synthesizing" class="cta__hint">
        {{ state === 'ready' ? 're-fan signals into a fresh decision' : 'fan signals into a single decision' }}
      </p>
    </footer>
  </aside>
</template>

<style scoped>
/* ── Container ───────────────────────────────────────────────── */
.verdict {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  overflow: hidden;
  position: relative;
  animation: verdict-rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}
/* Vertical ledger-margin stripe — a subtle binding of amber */
.verdict::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: linear-gradient(180deg,
    var(--accent) 0%,
    color-mix(in srgb, var(--accent) 15%, transparent) 60%,
    transparent 100%);
  opacity: 0.55;
  pointer-events: none;
}

@keyframes verdict-rise {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Head ────────────────────────────────────────────────────── */
.verdict__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid var(--ink-line);
}
.verdict__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--paper-1);
  white-space: nowrap;
  min-width: 0;
}
.verdict__sub {
  color: var(--paper-3);
  letter-spacing: 0.18em;
}
.verdict__sym {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paper-3);
  flex-shrink: 0;
}
.dot[data-state="ready"] {
  background: var(--accent);
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);
}
.dot[data-state="running"], .dot[data-state="synthesizing"] {
  background: var(--accent);
  animation: dot-breathe 1.2s ease-in-out infinite;
}
.dot[data-state="error"]   { background: var(--tape-down); }
.dot[data-state="awaiting"] { background: var(--accent); opacity: 0.6; }

@keyframes dot-breathe {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1;   transform: scale(1.2); }
}

/* ── Body ────────────────────────────────────────────────────── */
.verdict__body {
  flex: 1;
  padding: 1.1rem 1.1rem 0.6rem;
  min-height: 240px;
}

/* Non-ready states: a centered, dim placeholder block */
.ghost {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.95rem;
  text-align: center;
  padding: 1.5rem 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-3);
  letter-spacing: 0.04em;
  line-height: 1.55;
  min-height: 200px;
}
.ghost p { max-width: 28ch; }
.ghost__mark {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  color: var(--paper-3);
  opacity: 0.5;
}
.ghost--error                { color: var(--tape-down); }
.ghost--error .ghost__mark   { color: var(--tape-down); opacity: 0.85; }
.ghost--ready                { color: var(--paper-2); }
.ghost--live                 { color: var(--paper-2); }

.ring { display: inline-flex; gap: 5px; }
.ring span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.3;
  animation: ring-pulse 1.4s ease-in-out infinite;
}
.ring span:nth-child(2) { animation-delay: 0.18s; }
.ring span:nth-child(3) { animation-delay: 0.36s; }
@keyframes ring-pulse {
  0%, 60%, 100% { opacity: 0.25; transform: scale(0.85); }
  30%           { opacity: 1;    transform: scale(1); }
}

/* ── Decision card ───────────────────────────────────────────── */
.verdict__list {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.card {
  display: grid;
  gap: 0.95rem;
  animation: verdict-rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--stagger, 0ms);
}
.card__sym {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-1);
}

/* ── Trade ticket: hairlines flank the action stamp ──────────── */
.ticket {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0 0.6rem;
}
.ticket__rule {
  display: block;
  width: 60%;
  height: 1px;
  background: var(--ink-line-strong);
  transition: background 240ms ease;
}
.ticket[data-tone="up"]   .ticket__rule { background: color-mix(in srgb, var(--tape-up) 45%, transparent); }
.ticket[data-tone="down"] .ticket__rule { background: color-mix(in srgb, var(--tape-down) 45%, transparent); }

.ticket__action {
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 1.95rem;
  letter-spacing: 0.34em;
  /* trailing tracking pushes the visual center off; pad-left rebalances */
  padding-left: 0.34em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--paper-1);
  line-height: 1;
  animation: stamp-reveal 0.6s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both;
}
.ticket[data-tone="up"]   .ticket__action { color: var(--tape-up); }
.ticket[data-tone="down"] .ticket__action { color: var(--tape-down); }

@keyframes stamp-reveal {
  0%   { opacity: 0; letter-spacing: 0.05em; transform: scale(0.96); filter: blur(2px); }
  100% { opacity: 1; letter-spacing: 0.34em; transform: scale(1);    filter: blur(0); }
}

.ticket__qty {
  display: inline-flex;
  align-items: baseline;
  gap: 0.35em;
  font-family: var(--font-mono);
  margin-top: 0.05rem;
}
.ticket__qty-num {
  font-size: 0.95rem;
  color: var(--paper-1);
}
.ticket__qty-unit {
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}

/* ── Eyebrow utility ─────────────────────────────────────────── */
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}

/* ── Confidence ──────────────────────────────────────────────── */
.conf {
  border-top: 1px solid var(--ink-line);
  padding-top: 0.85rem;
}
.conf__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.45rem;
}
.conf__num {
  font-family: var(--font-mono);
  font-size: 0.92rem;
  color: var(--paper-1);
}
.conf__num[data-tone="up"]   { color: var(--tape-up); }
.conf__num[data-tone="down"] { color: var(--tape-down); }

.conf__bar {
  height: 2px;
  background: color-mix(in srgb, var(--paper-3) 16%, transparent);
  border-radius: 999px;
  overflow: hidden;
}
.conf__fill {
  height: 100%;
  width: 0%;
  background: var(--paper-2);
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1) 0.18s;
}
.conf__fill[data-tone="up"]   { background: var(--tape-up); }
.conf__fill[data-tone="down"] { background: var(--tape-down); }

/* ── Reasoning ───────────────────────────────────────────────── */
.reasoning {
  border-top: 1px solid var(--ink-line);
  padding-top: 0.85rem;
  display: grid;
  gap: 0.4rem;
}
.reasoning p {
  font-family: var(--font-sans);
  font-size: 0.875rem;
  color: var(--paper-1);
  line-height: 1.55;
  white-space: pre-wrap;
}

/* ── Actions ─────────────────────────────────────────────────── */
.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  margin-top: 0.25rem;
  padding: 0.65rem 0.9rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-0);
  background: var(--ink-2);
  border: 1px solid var(--ink-line-strong);
  border-radius: 5px;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
}
.send:hover:not(:disabled) {
  background: var(--ink-3);
  border-color: var(--accent);
  color: var(--accent);
}
.send:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.hold-tag {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.55rem 0;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
  border-top: 1px dashed var(--ink-line-strong);
  border-bottom: 1px dashed var(--ink-line-strong);
  margin-top: 0.25rem;
}

/* ── Footer / synthesize CTA ─────────────────────────────────── */
.verdict__foot {
  border-top: 1px solid var(--ink-line);
  padding: 0.85rem 1.1rem 1rem;
  display: grid;
  gap: 0.5rem;
}
.cta {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.55rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: #07080a;
  background: var(--accent);
  border: 1px solid var(--accent);
  padding: 0.7rem 1.1rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, opacity 160ms ease, color 160ms ease;
  white-space: nowrap;
}
.cta:hover:not(:disabled) {
  background: #b88a4f;
  border-color: #b88a4f;
}
.cta:disabled {
  background: rgba(212, 169, 106, 0.18);
  border-color: rgba(212, 169, 106, 0.25);
  color: rgba(7, 8, 10, 0.55);
  cursor: not-allowed;
}
.cta__hint {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.04em;
  color: var(--paper-3);
  text-align: center;
}

/* ── Spinners ────────────────────────────────────────────────── */
.spinner {
  width: 11px;
  height: 11px;
  border: 1.5px solid rgba(255, 245, 230, 0.25);
  border-top-color: var(--paper-0);
  border-radius: 50%;
  animation: spin 720ms linear infinite;
  flex-shrink: 0;
}
.spinner--ink {
  border-color: rgba(7, 8, 10, 0.3);
  border-top-color: #07080a;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
