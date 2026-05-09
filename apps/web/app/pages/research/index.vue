<script setup lang="ts">

definePageMeta({ section: 'research' })
import { computed, ref } from 'vue'
import type {
  AnalystName,
  Decision,
  PersonaName,
  ResearchRunResponse,
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

const symbol = ref('US.NVDA')
const selectedAnalysts = ref<AnalystName[]>(ANALYSTS.map(a => a.value))
const selectedPersonas = ref<PersonaName[]>([])

const running = ref(false)
const runError = ref<string | null>(null)
const signals = ref<Signal[]>([])
const lastSymbol = ref<string | null>(null)

const synthesizing = ref(false)
const synthError = ref<string | null>(null)
const decisions = ref<Decision[] | null>(null)

const canRun = computed(() => {
  return symbol.value.trim().length > 0
    && (selectedAnalysts.value.length > 0 || selectedPersonas.value.length > 0)
    && !running.value
})

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

async function runResearch() {
  runError.value = null
  decisions.value = null
  synthError.value = null
  running.value = true
  try {
    const res = await $fetch<ResearchRunResponse>('/api/research/run', {
      method: 'POST',
      body: {
        symbol: symbol.value.trim(),
        analysts: selectedAnalysts.value,
        personas: selectedPersonas.value,
      },
    })
    signals.value = res.signals
    lastSymbol.value = res.symbol
  } catch (e) {
    const err = e as { data?: { detail?: string; statusMessage?: string }; message?: string }
    runError.value = String(err?.data?.detail ?? err?.data?.statusMessage ?? err?.message ?? 'failed to run research')
  } finally {
    running.value = false
  }
}

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

          <div class="grid grid-cols-[1fr_auto] gap-4 items-end">
            <label class="block">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">symbol</span>
              <UInput
                v-model="symbol"
                placeholder="US.NVDA"
                class="mt-1 font-mono"
                @keyup.enter="canRun && runResearch()"
              />
            </label>
            <UButton
              :loading="running"
              :disabled="!canRun"
              color="primary"
              class="font-mono text-xs uppercase tracking-[0.18em]"
              @click="runResearch"
            >
              {{ running ? 'running…' : 'run research' }}
            </UButton>
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
                  @click="togglePersona(p.value)"
                >{{ p.label }}</button>
              </div>
            </div>
          </div>

          <div v-if="runError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ runError }}
          </div>
        </section>

        <!-- Signals grid -->
        <section v-if="signals.length > 0" class="space-y-4">
          <div class="flex items-baseline justify-between">
            <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
              signals · {{ lastSymbol }}
            </div>
            <div class="font-mono text-xs text-[var(--paper-3)]">{{ signals.length }} sources</div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PersonaSignalCard
              v-for="(s, i) in signals"
              :key="`${s.source}-${i}`"
              :signal="s"
            />
          </div>
        </section>

        <!-- Synthesize CTA + result -->
        <section v-if="signals.length > 0" class="space-y-4">
          <div class="flex items-center gap-4">
            <UButton
              :loading="synthesizing"
              :disabled="!canSynthesize"
              color="primary"
              variant="solid"
              class="font-mono text-xs uppercase tracking-[0.18em]"
              @click="synthesize"
            >
              {{ synthesizing ? 'synthesizing…' : 'synthesize decisions' }}
            </UButton>
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
          v-else-if="!running"
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
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease;
  cursor: pointer;
}
.chip:hover { border-color: var(--paper-3); color: var(--paper-0); }
.chip.is-on {
  color: #07080a;
  background: var(--accent);
  border-color: var(--accent);
}
.chip.is-on:hover { background: #b88a4f; border-color: #b88a4f; }
</style>
