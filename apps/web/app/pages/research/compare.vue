<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AnalystName, PersonaName } from '../../../types/research'

useHead({ title: 'research · compare' })

interface CompareSignal {
  source: string
  symbol: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
}
interface CompareDecision {
  symbol: string
  action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
  quantity: number
  confidence: number
  reasoning: string
}
interface CompareItem {
  symbol: string
  decision: CompareDecision | null
  signals: CompareSignal[]
  error: string | null
}
interface CompareResponse {
  generated_at: string
  items: CompareItem[]
}

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

const ACTION_RANK: Record<CompareDecision['action'], number> = {
  buy: 4,
  short: 3,
  sell: 2,
  cover: 1,
  hold: 0,
}

const symbolsInput = ref('US.AVGO, US.AMD, US.NVDA')
const selectedAnalysts = ref<AnalystName[]>(ANALYSTS.map(a => a.value))
const selectedPersonas = ref<PersonaName[]>([])

const running = ref(false)
const runError = ref<string | null>(null)
const generatedAt = ref<string | null>(null)
const items = ref<CompareItem[]>([])

const parsedSymbols = computed<string[]>(() =>
  symbolsInput.value
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 5),
)

const canRun = computed(() =>
  parsedSymbols.value.length >= 2
  && parsedSymbols.value.length <= 5
  && (selectedAnalysts.value.length > 0 || selectedPersonas.value.length > 0)
  && !running.value,
)

interface MatrixRow {
  source: string
  cells: Array<CompareSignal | null>
}

// Build a matrix where rows = sources, cells aligned to items[] order.
const matrix = computed<MatrixRow[]>(() => {
  const seen = new Set<string>()
  const sources: string[] = []
  for (const item of items.value) {
    for (const sig of item.signals) {
      if (!seen.has(sig.source)) {
        seen.add(sig.source)
        sources.push(sig.source)
      }
    }
  }
  return sources.map(source => ({
    source,
    cells: items.value.map(item => item.signals.find(s => s.source === source) ?? null),
  }))
})

const ranked = computed<CompareItem[]>(() => {
  return [...items.value].sort((a, b) => {
    const ar = a.decision ? (ACTION_RANK[a.decision.action] ?? 0) * 100 + pctNum(a.decision.confidence) : -1
    const br = b.decision ? (ACTION_RANK[b.decision.action] ?? 0) * 100 + pctNum(b.decision.confidence) : -1
    return br - ar
  })
})

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

async function runCompare() {
  runError.value = null
  running.value = true
  items.value = []
  try {
    const res = await $fetch<CompareResponse>('/api/research/compare', {
      method: 'POST',
      body: {
        symbols: parsedSymbols.value,
        analysts: selectedAnalysts.value,
        personas: selectedPersonas.value,
      },
    })
    items.value = res.items
    generatedAt.value = res.generated_at
  } catch (e) {
    const err = e as { data?: { detail?: string; statusMessage?: string }; message?: string }
    runError.value = String(err?.data?.detail ?? err?.data?.statusMessage ?? err?.message ?? 'failed to run compare')
  } finally {
    running.value = false
  }
}

function actionColor(action: CompareDecision['action']): 'success' | 'error' | 'warning' | 'neutral' {
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

function signalColor(direction: CompareSignal['signal']): 'success' | 'error' | 'neutral' {
  switch (direction) {
    case 'bullish': return 'success'
    case 'bearish': return 'error'
    default: return 'neutral'
  }
}

function signalToneClass(direction: CompareSignal['signal']): string {
  if (direction === 'bullish') return 'tape-up'
  if (direction === 'bearish') return 'tape-down'
  return 'text-[var(--paper-2)]'
}

function pctNum(n: number): number {
  const v = n <= 1 ? n * 100 : n
  return Math.max(0, Math.min(100, Math.round(v)))
}

function pct(n: number): string {
  return `${pctNum(n)}%`
}

function truncate(s: string, n = 90): string {
  if (!s) return ''
  const trimmed = s.replace(/\s+/g, ' ').trim()
  return trimmed.length <= n ? trimmed : trimmed.slice(0, n - 1) + '…'
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function rankSummaryLine(): string {
  return ranked.value
    .map((it, i) => {
      const n = i + 1
      if (it.error) return `${n}. ${it.symbol} (ERROR)`
      if (!it.decision) return `${n}. ${it.symbol} (no decision)`
      const d = it.decision
      const action = d.action.toUpperCase()
      const qtyPart = d.action === 'hold' ? '' : ` ${d.quantity}`
      return `${n}. ${it.symbol} (${action}${qtyPart}, ${pct(d.confidence)})`
    })
    .join('  ')
}
</script>

<template>
  <div class="h-screen flex flex-col bg-[var(--ink-0)] text-[var(--paper-0)]">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <NuxtLink to="/" class="brand-mark">
          <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
        </NuxtLink>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research · compare</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/research" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          ← research
        </NuxtLink>
        <NuxtLink to="/research/digest" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          digest
        </NuxtLink>
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          algo →
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-7xl mx-auto px-7 py-8 space-y-8">
        <!-- Form -->
        <section class="surface-1 p-6 space-y-5">
          <div class="flex items-baseline justify-between">
            <div>
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                multi-ticker compare
              </div>
              <p class="mt-2 text-sm text-[var(--paper-2)] leading-relaxed max-w-2xl">
                Pit 2-5 symbols against each other. Runs analyze on each (sequential — moomoo + LLM rate limits) and ranks the outputs side-by-side.
              </p>
            </div>
            <div class="font-mono text-xs text-[var(--paper-3)]">
              last run · {{ fmtTime(generatedAt) }}
            </div>
          </div>

          <div>
            <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-2">
              symbols <span class="opacity-60">(2-5, comma or space separated)</span>
            </div>
            <UInput
              v-model="symbolsInput"
              placeholder="US.AVGO, US.AMD, US.NVDA"
              class="font-mono w-full"
              @keyup.enter="canRun && runCompare()"
            />
            <div class="mt-2 flex items-center gap-3 font-mono text-xs text-[var(--paper-3)]">
              <span data-mono>{{ parsedSymbols.length }} parsed</span>
              <span v-if="parsedSymbols.length > 0" class="text-[var(--paper-2)]" data-mono>
                {{ parsedSymbols.join(' · ') }}
              </span>
              <span v-if="parsedSymbols.length < 2" class="text-[var(--tape-down)]" data-mono>
                need at least 2
              </span>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-6">
            <div>
              <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-3">analysts</div>
              <div class="flex flex-wrap gap-3">
                <UCheckbox
                  v-for="a in ANALYSTS"
                  :key="a.value"
                  :model-value="selectedAnalysts.includes(a.value)"
                  :label="a.label"
                  @update:model-value="toggleAnalyst(a.value)"
                />
              </div>
            </div>
            <div>
              <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-3">
                personas <span class="opacity-60">(optional · slower, costs more)</span>
              </div>
              <div class="flex flex-wrap gap-3">
                <UCheckbox
                  v-for="p in PERSONAS"
                  :key="p.value"
                  :model-value="selectedPersonas.includes(p.value)"
                  :label="p.label"
                  @update:model-value="togglePersona(p.value)"
                />
              </div>
            </div>
          </div>

          <div class="flex items-center gap-4 pt-2">
            <UButton
              :loading="running"
              :disabled="!canRun"
              color="primary"
              class="font-mono text-xs uppercase tracking-[0.18em]"
              @click="runCompare"
            >
              {{ running ? 'running…' : 'compare' }}
            </UButton>
            <span v-if="running" class="font-mono text-xs text-[var(--paper-3)]">
              analyzing {{ parsedSymbols.length }} symbols sequentially…
            </span>
          </div>

          <div v-if="runError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ runError }}
          </div>
        </section>

        <!-- Loading state -->
        <section v-if="running && items.length === 0" class="surface-1 p-10 text-center">
          <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">
            running…
          </div>
          <div class="text-sm text-[var(--paper-2)]">
            results will appear here when the comparison completes.
          </div>
        </section>

        <!-- Results -->
        <template v-if="!running && items.length > 0">
          <!-- Comparison table: columns = symbols, rows = sources + decision -->
          <section class="surface-1 rounded-md overflow-hidden">
            <div class="px-5 py-3 border-b hairline flex items-baseline justify-between">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
                side-by-side
              </div>
              <div class="font-mono text-xs text-[var(--paper-3)]" data-mono>
                {{ items.length }} symbols · {{ matrix.length }} sources
              </div>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full border-collapse">
                <thead>
                  <tr class="border-b hairline">
                    <th class="text-left px-4 py-3 font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] w-40">
                      source
                    </th>
                    <th
                      v-for="item in items"
                      :key="`h-${item.symbol}`"
                      class="text-left px-4 py-3 font-mono text-sm text-[var(--paper-0)] align-bottom"
                    >
                      <div data-mono>{{ item.symbol }}</div>
                      <div v-if="item.error" class="font-mono text-xs text-[var(--tape-down)] mt-1">
                        error
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in matrix"
                    :key="row.source"
                    class="border-b hairline"
                  >
                    <td class="px-4 py-3 align-top font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                      {{ row.source }}
                    </td>
                    <td
                      v-for="(cell, ci) in row.cells"
                      :key="`${row.source}-${ci}`"
                      class="px-4 py-3 align-top w-1/4 min-w-[180px]"
                    >
                      <template v-if="cell">
                        <div class="flex items-center gap-2 mb-1">
                          <UBadge
                            :color="signalColor(cell.signal)"
                            variant="soft"
                            class="font-mono text-[10px] uppercase tracking-[0.18em]"
                          >
                            {{ cell.signal }}
                          </UBadge>
                          <span
                            class="font-mono text-xs"
                            :class="signalToneClass(cell.signal)"
                            data-mono
                          >
                            {{ pct(cell.confidence) }}
                          </span>
                        </div>
                        <div
                          class="text-xs text-[var(--paper-2)] leading-snug truncate"
                          :title="cell.reasoning"
                        >
                          {{ truncate(cell.reasoning) }}
                        </div>
                      </template>
                      <template v-else>
                        <span class="font-mono text-xs text-[var(--paper-3)]">—</span>
                      </template>
                    </td>
                  </tr>

                  <!-- Decision row -->
                  <tr class="bg-[var(--ink-1)]">
                    <td class="px-4 py-3 align-top font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-2)]">
                      decision
                    </td>
                    <td
                      v-for="item in items"
                      :key="`d-${item.symbol}`"
                      class="px-4 py-3 align-top"
                    >
                      <template v-if="item.error">
                        <div
                          class="font-mono text-xs text-[var(--tape-down)] whitespace-pre-wrap"
                          :title="item.error"
                        >
                          {{ truncate(item.error, 120) }}
                        </div>
                      </template>
                      <template v-else-if="item.decision">
                        <div class="flex items-center gap-2 mb-1">
                          <UBadge
                            :color="actionColor(item.decision.action)"
                            variant="soft"
                            class="font-mono text-[10px] uppercase tracking-[0.18em]"
                          >
                            {{ item.decision.action }}
                          </UBadge>
                          <span class="font-mono text-xs text-[var(--paper-2)]" data-mono>
                            qty {{ item.decision.quantity }}
                          </span>
                          <span class="font-mono text-xs text-[var(--paper-2)]" data-mono>
                            {{ pct(item.decision.confidence) }}
                          </span>
                        </div>
                        <div
                          class="text-xs text-[var(--paper-2)] leading-snug truncate"
                          :title="item.decision.reasoning"
                        >
                          {{ truncate(item.decision.reasoning) }}
                        </div>
                      </template>
                      <template v-else>
                        <span class="font-mono text-xs text-[var(--paper-3)]">no decision</span>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Rank summary -->
          <section class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-2">
              rank
            </div>
            <div class="font-mono text-sm text-[var(--paper-1)] leading-relaxed" data-mono>
              {{ rankSummaryLine() }}
            </div>
          </section>
        </template>

        <div
          v-else-if="!running"
          class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
        >
          enter 2-5 symbols and click <span class="text-[var(--paper-1)]">compare</span> to rank them.
        </div>
      </div>
    </main>
  </div>
</template>
