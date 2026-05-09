<script setup lang="ts">

definePageMeta({ section: 'research' })
import { computed, onUnmounted, ref, watch } from 'vue'
import { useEventSource } from '@vueuse/core'
import type {
  AnalystName,
  Decision,
  PersonaName,
  ResearchEvent,
  ResearchSourceName,
  Signal,
  SynthesisResponse,
} from '../../../types/research'

useHead({ title: 'research' })

const ANALYSTS: { value: AnalystName; label: string }[] = [
  { value: 'fundamentals', label: 'Fundamentals' },
  { value: 'valuation', label: 'Valuation' },
  { value: 'technicals', label: 'Technicals' },
  { value: 'sentiment', label: 'Sentiment' },
]

const PERSONAS: { value: PersonaName; label: string }[] = [
  { value: 'buffett', label: 'Buffett' },
  { value: 'munger', label: 'Munger' },
  { value: 'burry', label: 'Burry' },
  { value: 'druckenmiller', label: 'Druckenmiller' },
  { value: 'wood', label: 'Wood' },
]

type SourceStatus = 'pending' | 'running' | 'done' | 'error'

interface SourceEntry {
  name: ResearchSourceName
  label: string
  status: SourceStatus
  signal: Signal | null
  error: string | null
}

const symbol = ref('US.NVDA')
const selectedAnalysts = ref<AnalystName[]>(ANALYSTS.map(a => a.value))
const selectedPersonas = ref<PersonaName[]>([])

const sources = ref<SourceEntry[]>([])
const lastSymbol = ref<string | null>(null)
const runError = ref<string | null>(null)

const synthesizing = ref(false)
const synthError = ref<string | null>(null)
const decisions = ref<Decision[] | null>(null)

const RESEARCH_EVENTS = ['progress', 'signal', 'error', 'done', 'ping'] as const

const url = ref<string | undefined>(undefined)
const { event, data, status, close, open } = useEventSource(
  url,
  RESEARCH_EVENTS as unknown as string[],
  { immediate: false, autoReconnect: false },
)

const running = computed(() => status.value === 'OPEN' || status.value === 'CONNECTING')
const total = computed(() => sources.value.length)
const completed = computed(() =>
  sources.value.filter(s => s.status === 'done' || s.status === 'error').length,
)
const progressPct = computed(() =>
  total.value === 0 ? 0 : Math.round((completed.value / total.value) * 100),
)

const signals = computed<Signal[]>(() =>
  sources.value
    .map(s => s.signal)
    .filter((s): s is Signal => s !== null),
)

const canRun = computed(() =>
  symbol.value.trim().length > 0
  && (selectedAnalysts.value.length > 0 || selectedPersonas.value.length > 0)
  && !running.value,
)
const canSynthesize = computed(() => signals.value.length > 0 && !synthesizing.value)

function toggleAnalyst(a: AnalystName) {
  const idx = selectedAnalysts.value.indexOf(a)
  if (idx >= 0) selectedAnalysts.value.splice(idx, 1)
  else selectedAnalysts.value.push(a)
}

function togglePersona(p: PersonaName) {
  const idx = selectedPersonas.value.indexOf(p)
  if (idx >= 0) selectedPersonas.value.splice(idx, 1)
  else selectedPersonas.value.push(p)
}

function labelFor(name: string): string {
  const a = ANALYSTS.find(x => x.value === name)
  if (a) return a.label
  const p = PERSONAS.find(x => x.value === name)
  if (p) return p.label
  return name
}

function runResearch() {
  if (running.value) return
  runError.value = null
  synthError.value = null
  decisions.value = null

  const trimmed = symbol.value.trim()
  if (!trimmed) return
  lastSymbol.value = trimmed

  // Pre-populate sources in selection order so skeletons render immediately.
  sources.value = [
    ...selectedAnalysts.value.map((a): SourceEntry => ({
      name: a,
      label: labelFor(a),
      status: 'pending',
      signal: null,
      error: null,
    })),
    ...selectedPersonas.value.map((p): SourceEntry => ({
      name: p,
      label: labelFor(p),
      status: 'pending',
      signal: null,
      error: null,
    })),
  ]

  const params = new URLSearchParams({
    symbol: trimmed,
    analysts: selectedAnalysts.value.join(','),
    personas: selectedPersonas.value.join(','),
  })
  url.value = `/api/research/run?${params.toString()}`
  open()
}

function stopResearch() {
  close()
  // Mark any still-pending/running source as error so the UI doesn't lie.
  for (const s of sources.value) {
    if (s.status === 'pending' || s.status === 'running') {
      s.status = 'error'
      s.error = 'cancelled'
    }
  }
}

watch([event, data], ([ev, dat]) => {
  if (!ev || dat == null) return
  let payload: ResearchEvent | null = null
  try {
    payload = JSON.parse(dat as string) as ResearchEvent
  } catch {
    return
  }
  if (!payload) return

  if (payload.kind === 'progress') {
    const entry = sources.value.find(s => s.name === payload.source)
    if (entry && entry.status === 'pending') entry.status = 'running'
  } else if (payload.kind === 'signal') {
    const entry = sources.value.find(s => s.name === payload.source)
    if (entry) {
      entry.signal = payload.signal
      entry.status = 'done'
      entry.error = null
    }
  } else if (payload.kind === 'error') {
    const entry = sources.value.find(s => s.name === payload.source)
    if (entry) {
      entry.error = payload.message
      entry.status = 'error'
    }
    if (payload.fatal) {
      runError.value = payload.message
      close()
    }
  } else if (payload.kind === 'done') {
    close()
  }
})

async function synthesize() {
  synthError.value = null
  synthesizing.value = true
  try {
    const res = await $fetch<SynthesisResponse>('/api/research/synthesize', {
      method: 'POST',
      body: {
        symbols: lastSymbol.value ? [lastSymbol.value] : [],
        signals: signals.value,
      },
    })
    decisions.value = res.decisions
  } catch (e) {
    const err = e as { data?: { detail?: string; statusMessage?: string }; message?: string }
    synthError.value = String(err?.data?.detail ?? err?.data?.statusMessage ?? err?.message ?? 'failed to synthesize decisions')
  } finally {
    synthesizing.value = false
  }
}

onUnmounted(() => close())
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          algo →
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto px-7 py-8 space-y-8">
        <!-- Run form -->
        <section class="surface-1 p-6 space-y-5">
          <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
            new research pass
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 sm:gap-4 sm:items-end">
            <label class="flex flex-col gap-2">
              <span class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">symbol</span>
              <SymbolSearchInput
                v-model="symbol"
                placeholder="search NVDA, tencent, 600519…"
                @submit="canRun && runResearch()"
              />
            </label>
            <button
              type="button"
              :class="['run-btn', { 'is-stop': running }]"
              :disabled="!running && !canRun"
              @click="running ? stopResearch() : runResearch()"
            >
              <span v-if="running" class="dot-pulse" aria-hidden="true" />
              <span>{{ running ? 'stop ◼' : 'run research →' }}</span>
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div>
              <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-3">analysts</div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="a in ANALYSTS"
                  :key="a.value"
                  type="button"
                  class="chip"
                  :class="{ 'is-on': selectedAnalysts.includes(a.value) }"
                  :disabled="running"
                  @click="toggleAnalyst(a.value)"
                >{{ a.label }}</button>
              </div>
            </div>
            <div>
              <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-3">personas <span class="opacity-60">(optional)</span></div>
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="p in PERSONAS"
                  :key="p.value"
                  type="button"
                  class="chip"
                  :class="{ 'is-on': selectedPersonas.includes(p.value) }"
                  :disabled="running"
                  @click="togglePersona(p.value)"
                >{{ p.label }}</button>
              </div>
            </div>
          </div>

          <div v-if="runError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ runError }}
          </div>
        </section>

        <!-- Signals grid: skeleton-per-source while streaming, real cards as they land -->
        <section v-if="sources.length > 0" class="space-y-4">
          <div class="flex items-baseline justify-between gap-4">
            <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
              signals · {{ lastSymbol }}
            </div>
            <div class="flex items-baseline gap-3 font-mono text-xs text-[var(--paper-3)]">
              <span data-mono>
                [{{ String(completed).padStart(2, '0') }} / {{ String(total).padStart(2, '0') }}]
              </span>
              <span v-if="running" class="streaming-tag">streaming<span class="dots"><span>.</span><span>.</span><span>.</span></span></span>
              <span v-else>complete</span>
            </div>
          </div>

          <div class="progress-track">
            <div class="progress-fill" :style="{ width: progressPct + '%' }" />
            <div v-if="running" class="progress-pulse" />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              v-for="(s, i) in sources"
              :key="s.name"
              class="signal-slot"
              :style="{ '--stagger': `${i * 60}ms` }"
            >
              <Transition name="slot" mode="out-in">
                <PersonaSignalCard
                  v-if="s.status === 'done' && s.signal"
                  :key="'sig'"
                  :signal="s.signal"
                />
                <SignalErrorCard
                  v-else-if="s.status === 'error'"
                  :key="'err'"
                  :source="s.label"
                  :message="s.error || ''"
                />
                <SignalSkeleton
                  v-else
                  :key="'skel'"
                  :source="s.label"
                  :running="s.status === 'running'"
                />
              </Transition>
            </div>
          </div>
        </section>

        <!-- Synthesize CTA + result -->
        <section v-if="signals.length > 0" class="space-y-4">
          <div class="flex items-center gap-4 flex-wrap">
            <button
              type="button"
              class="run-btn"
              :disabled="!canSynthesize"
              @click="synthesize"
            >
              <span v-if="synthesizing" class="spinner" aria-hidden="true" />
              <span>{{ synthesizing ? 'synthesizing…' : 'synthesize decisions →' }}</span>
            </button>
            <span class="font-mono text-xs text-[var(--paper-3)]">
              fan signals into a single decision per symbol
            </span>
          </div>

          <div v-if="synthError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ synthError }}
          </div>

          <SynthesisCard v-if="decisions" :decisions="decisions" />
        </section>

        <div
          v-else-if="!running && sources.length === 0"
          class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
        >
          enter a symbol and pick analysts to begin.
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.chip {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  padding: 0.45rem 0.85rem;
  border: 1px solid var(--hairline, rgba(255,245,230,0.12));
  border-radius: 6px;
  color: var(--paper-2);
  background: transparent;
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease, opacity 160ms ease;
  cursor: pointer;
}
.chip:hover:not(:disabled) { border-color: var(--paper-3); color: var(--paper-0); }
.chip:disabled { opacity: 0.5; cursor: not-allowed; }
.chip.is-on {
  color: #07080a;
  background: var(--accent);
  border-color: var(--accent);
}
.chip.is-on:hover:not(:disabled) { background: #b88a4f; border-color: #b88a4f; }

.run-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: #07080a;
  background: var(--accent);
  border: 1px solid var(--accent);
  padding: 0.65rem 1.1rem;
  border-radius: 6px;
  transition: background-color 160ms ease, border-color 160ms ease, opacity 160ms ease, color 160ms ease;
  cursor: pointer;
  white-space: nowrap;
}
.run-btn:hover:not(:disabled) {
  background: #b88a4f;
  border-color: #b88a4f;
}
.run-btn:disabled {
  background: rgba(212, 169, 106, 0.18);
  border-color: rgba(212, 169, 106, 0.25);
  color: rgba(7, 8, 10, 0.55);
  cursor: not-allowed;
}
.run-btn.is-stop {
  background: transparent;
  border-color: color-mix(in srgb, var(--tape-down) 65%, transparent);
  color: var(--tape-down);
}
.run-btn.is-stop:hover:not(:disabled) {
  background: color-mix(in srgb, var(--tape-down) 12%, transparent);
  border-color: var(--tape-down);
}

.spinner {
  width: 12px;
  height: 12px;
  border: 1.5px solid rgba(7, 8, 10, 0.3);
  border-top-color: #07080a;
  border-radius: 50%;
  animation: spin 720ms linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Pulsing dot used inside the stop button while streaming */
.dot-pulse {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--tape-down);
  flex-shrink: 0;
  animation: dot-breathe 1.2s ease-in-out infinite;
}
@keyframes dot-breathe {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50%      { opacity: 1;   transform: scale(1.15); }
}

/* Streaming · · · indicator */
.streaming-tag { color: var(--accent); }
.dots {
  display: inline-flex;
  margin-left: 1px;
  letter-spacing: 0.04em;
}
.dots span {
  opacity: 0.25;
  animation: dot-pulse 1.4s ease-in-out infinite;
}
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-pulse {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

/* Hairline progress track. Fill is the accent; pulse is a thin sweep so the
   progress feels alive even when no source has resolved yet. */
.progress-track {
  position: relative;
  height: 1px;
  width: 100%;
  background: color-mix(in srgb, var(--paper-3) 14%, transparent);
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: var(--accent);
  transition: width 480ms cubic-bezier(0.22, 1, 0.36, 1);
}
.progress-pulse {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--accent) 70%, transparent) 50%,
    transparent 100%
  );
  width: 30%;
  animation: pulse-sweep 1.6s ease-in-out infinite;
  mix-blend-mode: screen;
}
@keyframes pulse-sweep {
  0%   { transform: translateX(-30%); }
  100% { transform: translateX(330%); }
}

/* Per-slot Transition: skeleton/error → signal swap. Stagger via --stagger. */
.signal-slot { contain: layout; }

.slot-enter-from {
  opacity: 0;
  transform: translateY(6px);
  filter: blur(2px);
}
.slot-enter-active {
  transition:
    opacity 320ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 320ms ease-out;
  transition-delay: var(--stagger, 0ms);
}
.slot-enter-to {
  opacity: 1;
  transform: translateY(0);
  filter: blur(0);
}
.slot-leave-from { opacity: 1; }
.slot-leave-active { transition: opacity 140ms ease-in; }
.slot-leave-to { opacity: 0; }
</style>
