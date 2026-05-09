<script setup lang="ts">

definePageMeta({ section: 'research' })
import { computed, ref } from 'vue'
import type { AnalystName, PersonaName } from '../../../types/research'

useHead({ title: 'research · digest' })

interface DigestSignal {
  source: string
  symbol: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
}
interface DigestDecision {
  symbol: string
  action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
  quantity: number
  confidence: number
  reasoning: string
}
interface DigestItem {
  symbol: string
  decision: DigestDecision | null
  signals: DigestSignal[]
  error: string | null
}
interface DigestResponse {
  generated_at: string
  items: DigestItem[]
}

const ANALYSTS: { value: AnalystName; label: string }[] = [
  { value: 'fundamentals', label: 'Fundamentals' },
  { value: 'valuation', label: 'Valuation' },
  { value: 'technicals', label: 'Technicals' },
  { value: 'sentiment', label: 'Sentiment' },
]

const ALL_PERSONAS: PersonaName[] = ['buffett', 'munger', 'burry', 'druckenmiller', 'wood']

const includePersonas = ref(false)
const selectedAnalysts = ref<AnalystName[]>(ANALYSTS.map(a => a.value))

const running = ref(false)
const runError = ref<string | null>(null)
const generatedAt = ref<string | null>(null)
const items = ref<DigestItem[]>([])
const expanded = ref<Record<string, boolean>>({})

const canRun = computed(() => selectedAnalysts.value.length > 0 && !running.value)

const decisions = computed<DigestDecision[]>(() =>
  items.value.flatMap(i => (i.decision ? [i.decision] : [])),
)

const summary = computed(() => {
  const total = items.value.length
  const counts = { buy: 0, sell: 0, short: 0, cover: 0, hold: 0, error: 0, none: 0 }
  for (const it of items.value) {
    if (it.error) counts.error += 1
    else if (!it.decision) counts.none += 1
    else counts[it.decision.action] += 1
  }
  return { total, counts }
})

function toggleAnalyst(a: AnalystName) {
  const idx = selectedAnalysts.value.indexOf(a)
  if (idx >= 0) selectedAnalysts.value.splice(idx, 1)
  else selectedAnalysts.value.push(a)
}

function toggleExpand(symbol: string) {
  expanded.value[symbol] = !expanded.value[symbol]
}

async function runDigest() {
  runError.value = null
  running.value = true
  items.value = []
  expanded.value = {}
  try {
    const res = await $fetch<DigestResponse>('/api/research/digest', {
      method: 'POST',
      body: {
        analysts: selectedAnalysts.value,
        personas: includePersonas.value ? ALL_PERSONAS : [],
      },
    })
    items.value = res.items
    generatedAt.value = res.generated_at
  } catch (e) {
    const err = e as { data?: { detail?: string; statusMessage?: string }; message?: string }
    runError.value = String(err?.data?.detail ?? err?.data?.statusMessage ?? err?.message ?? 'failed to run digest')
  } finally {
    running.value = false
  }
}

function actionColor(action: DigestDecision['action']): 'success' | 'error' | 'warning' | 'neutral' {
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

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research · digest</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/research" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          ← research
        </NuxtLink>
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          algo →
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto px-7 py-8 space-y-8">
        <section class="surface-1 p-6 space-y-5">
          <div class="flex items-baseline justify-between">
            <div>
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                watchlist research digest
              </div>
              <p class="mt-2 text-sm text-[var(--paper-2)] leading-relaxed max-w-2xl">
                Run analyze_ticker on every symbol in your watchlist, ranked by confidence-weighted action priority. Sequential — moomoo + LLM rate limits make this slow but predictable.
              </p>
            </div>
            <div class="font-mono text-xs text-[var(--paper-3)]">
              last run · {{ fmtTime(generatedAt) }}
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
              <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] mb-3">personas</div>
              <UCheckbox
                v-model="includePersonas"
                label="Include all 5 personas (slower, costs more)"
              />
            </div>
          </div>

          <div class="flex items-center gap-4 pt-2">
            <UButton
              :loading="running"
              :disabled="!canRun"
              color="primary"
              class="font-mono text-xs uppercase tracking-[0.18em]"
              @click="runDigest"
            >
              {{ running ? 'running…' : 'run digest' }}
            </UButton>
            <span v-if="running" class="font-mono text-xs text-[var(--paper-3)]">
              fetching watchlist + analyzing each symbol sequentially. this can take a while.
            </span>
          </div>

          <div v-if="runError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ runError }}
          </div>
        </section>

        <section v-if="running && items.length === 0" class="surface-1 p-10 text-center">
          <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">
            running…
          </div>
          <div class="text-sm text-[var(--paper-2)]">
            analyzing watchlist. results will appear here when the pass finishes.
          </div>
        </section>

        <template v-if="!running && items.length > 0">
          <section class="surface-1 p-6">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">summary</div>
            <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-[var(--paper-2)]">
              <span class="font-mono" data-mono>{{ summary.total }} symbols analyzed</span>
              <span v-if="summary.counts.buy" class="font-mono tape-up" data-mono>{{ summary.counts.buy }} BUY</span>
              <span v-if="summary.counts.cover" class="font-mono tape-up" data-mono>{{ summary.counts.cover }} COVER</span>
              <span v-if="summary.counts.short" class="font-mono tape-down" data-mono>{{ summary.counts.short }} SHORT</span>
              <span v-if="summary.counts.sell" class="font-mono tape-down" data-mono>{{ summary.counts.sell }} SELL</span>
              <span v-if="summary.counts.hold" class="font-mono" data-mono>{{ summary.counts.hold }} HOLD</span>
              <span v-if="summary.counts.none" class="font-mono text-[var(--paper-3)]" data-mono>{{ summary.counts.none }} no decision</span>
              <span v-if="summary.counts.error" class="font-mono text-[var(--tape-down)]" data-mono>{{ summary.counts.error }} error</span>
            </div>
          </section>

          <section v-if="decisions.length > 0">
            <SynthesisCard :decisions="decisions" />
          </section>

          <section class="space-y-3">
            <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
              per-symbol detail
            </div>
            <div
              v-for="item in items"
              :key="item.symbol"
              class="surface-1 rounded-md overflow-hidden"
            >
              <button
                class="w-full px-5 py-3 flex items-center justify-between gap-4 hover:bg-[var(--ink-2)] transition-colors text-left"
                @click="toggleExpand(item.symbol)"
              >
                <div class="flex items-center gap-4 min-w-0">
                  <div class="font-mono text-base text-[var(--paper-0)]" data-mono>{{ item.symbol }}</div>
                  <UBadge
                    v-if="item.decision"
                    :color="actionColor(item.decision.action)"
                    variant="soft"
                    class="font-mono text-xs uppercase tracking-[0.18em]"
                  >
                    {{ item.decision.action }}
                  </UBadge>
                  <UBadge
                    v-else-if="item.error"
                    color="error"
                    variant="soft"
                    class="font-mono text-xs uppercase tracking-[0.18em]"
                  >
                    error
                  </UBadge>
                  <UBadge
                    v-else
                    color="neutral"
                    variant="soft"
                    class="font-mono text-xs uppercase tracking-[0.18em]"
                  >
                    no decision
                  </UBadge>
                  <span v-if="item.decision" class="font-mono text-xs text-[var(--paper-3)]" data-mono>
                    qty {{ item.decision.quantity }} · conf {{ pct(item.decision.confidence) }}
                  </span>
                </div>
                <div class="font-mono text-xs text-[var(--paper-3)]">
                  {{ item.signals.length }} signals · {{ expanded[item.symbol] ? '−' : '+' }}
                </div>
              </button>

              <div v-if="expanded[item.symbol]" class="border-t hairline px-5 py-4 space-y-4">
                <div v-if="item.error" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
                  {{ item.error }}
                </div>
                <div v-if="item.decision">
                  <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-2">reasoning</div>
                  <p class="text-sm text-[var(--paper-2)] leading-relaxed whitespace-pre-wrap">
                    {{ item.decision.reasoning }}
                  </p>
                </div>
                <div v-if="item.signals.length > 0">
                  <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">signals</div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <PersonaSignalCard
                      v-for="(s, i) in item.signals"
                      :key="`${item.symbol}-${s.source}-${i}`"
                      :signal="s"
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </template>

        <div
          v-else-if="!running"
          class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
        >
          click <span class="text-[var(--paper-1)]">run digest</span> to analyze every symbol in your watchlist.
        </div>
      </div>
    </main>
  </div>
</template>
