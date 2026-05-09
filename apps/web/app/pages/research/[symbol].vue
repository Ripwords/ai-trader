<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SignalDirection } from '../../../types/research'

interface Signal {
  id: number
  symbol: string
  source: string
  signal: SignalDirection
  confidence: number
  reasoning: string
  metadata: Record<string, unknown> | null
  ts: string
}

interface SignalsResponse {
  signals: Signal[]
}

type SourceKind = 'persona' | 'analyst' | 'other'
type FilterKind = 'all' | 'personas' | 'analysts'

const route = useRoute()
const symbol = computed(() => decodeURIComponent(route.params.symbol as string))

useHead({ title: () => `research · ${symbol.value}` })

const { data } = await useFetch<SignalsResponse>('/api/research/signals', {
  query: { symbol, limit: 200 },
  default: () => ({ signals: [] }),
})

const signals = computed<Signal[]>(() => {
  const list = data.value?.signals ?? []
  return [...list].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
})

function classifySource(source: string): SourceKind {
  if (source.startsWith('persona:')) return 'persona'
  if (source.startsWith('analyst:')) return 'analyst'
  return 'other'
}

function sourceKey(source: string): string {
  const colon = source.indexOf(':')
  return colon >= 0 ? source.slice(colon + 1) : source
}

function sourceLabel(source: string): string {
  const key = sourceKey(source)
  return key.charAt(0).toUpperCase() + key.slice(1)
}

function sourceKindLabel(source: string): string {
  const kind = classifySource(source)
  if (kind === 'persona') return 'persona'
  if (kind === 'analyst') return 'analyst'
  return source
}

const kindFilter = ref<FilterKind>('all')
const excludedSources = ref<Set<string>>(new Set())

const allSources = computed<string[]>(() => {
  const seen = new Set<string>()
  for (const s of signals.value) seen.add(s.source)
  return [...seen].sort()
})

const filteredSignals = computed<Signal[]>(() => {
  return signals.value.filter((s) => {
    const kind = classifySource(s.source)
    if (kindFilter.value === 'personas' && kind !== 'persona') return false
    if (kindFilter.value === 'analysts' && kind !== 'analyst') return false
    if (excludedSources.value.has(s.source)) return false
    return true
  })
})

function toggleSource(source: string) {
  const next = new Set(excludedSources.value)
  if (next.has(source)) next.delete(source)
  else next.add(source)
  excludedSources.value = next
}

function setKindFilter(k: FilterKind) {
  kindFilter.value = k
}

const latestBySource = computed<Signal[]>(() => {
  const map = new Map<string, Signal>()
  for (const s of filteredSignals.value) {
    const existing = map.get(s.source)
    if (!existing || new Date(s.ts).getTime() > new Date(existing.ts).getTime()) {
      map.set(s.source, s)
    }
  }
  return [...map.values()].sort((a, b) => a.source.localeCompare(b.source))
})

interface DayGroup {
  key: string
  label: string
  signals: Signal[]
}

const groupedByDay = computed<DayGroup[]>(() => {
  const groups = new Map<string, Signal[]>()
  for (const s of filteredSignals.value) {
    const d = new Date(s.ts)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, arr]) => ({
      key,
      label: formatDayLabel(arr[0]!.ts),
      signals: arr,
    }))
})

function formatDayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const yest = new Date(today)
  yest.setDate(today.getDate() - 1)
  const isYest = d.toDateString() === yest.toDateString()
  const fmt = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  if (isToday) return `Today · ${fmt}`
  if (isYest) return `Yesterday · ${fmt}`
  return fmt
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function relativeFromNow(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  return `${mo}mo ago`
}

const summary = computed(() => {
  const list = signals.value
  if (list.length === 0) return null
  const newest = new Date(list[0]!.ts).getTime()
  const oldest = new Date(list[list.length - 1]!.ts).getTime()
  const spanMs = newest - oldest
  const spanDays = Math.max(1, Math.round(spanMs / (24 * 60 * 60 * 1000)))
  const spanLabel
    = spanDays < 7 ? `${spanDays} day${spanDays === 1 ? '' : 's'}`
      : spanDays < 60 ? `${Math.round(spanDays / 7)} week${Math.round(spanDays / 7) === 1 ? '' : 's'}`
        : `${Math.round(spanDays / 30)} months`
  return {
    count: list.length,
    span: spanLabel,
    latestRel: relativeFromNow(list[0]!.ts),
  }
})

function directionColor(d: SignalDirection): 'success' | 'error' | 'neutral' {
  if (d === 'bullish') return 'success'
  if (d === 'bearish') return 'error'
  return 'neutral'
}

function barClass(d: SignalDirection): string {
  if (d === 'bullish') return 'bg-[var(--tape-up)]'
  if (d === 'bearish') return 'bg-[var(--tape-down)]'
  return 'bg-[var(--paper-3)]'
}

function pctClass(d: SignalDirection): string {
  if (d === 'bullish') return 'tape-up'
  if (d === 'bearish') return 'tape-down'
  return 'text-[var(--paper-2)]'
}

function pct(v: number): number {
  const x = v <= 1 ? v * 100 : v
  return Math.max(0, Math.min(100, Math.round(x)))
}

const expanded = ref<Set<number>>(new Set())
function toggleExpand(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
</script>

<template>
  <div class="h-screen flex flex-col bg-[var(--ink-0)] text-[var(--paper-0)]">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <NuxtLink to="/" class="brand-mark">
          <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
        </NuxtLink>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]" data-mono>{{ symbol }}</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink
          to="/research"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          ← research
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-5xl mx-auto px-7 py-8 space-y-8">
        <section class="surface-1 p-6 space-y-3">
          <div class="flex items-baseline justify-between gap-4">
            <div class="flex items-baseline gap-4 min-w-0">
              <h1 class="font-mono text-2xl tracking-[0.1em]" data-mono>{{ symbol }}</h1>
              <span class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">signal timeline</span>
            </div>
          </div>
          <div v-if="summary" class="font-mono text-sm text-[var(--paper-2)]">
            {{ summary.count }} signal{{ summary.count === 1 ? '' : 's' }} tracked over {{ summary.span }}
            · latest pass: {{ summary.latestRel }}
          </div>
          <div v-else class="font-mono text-sm text-[var(--paper-3)]">
            no signals recorded for this symbol yet.
          </div>
        </section>

        <section v-if="latestBySource.length > 0" class="space-y-3">
          <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
            current consensus
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div
              v-for="s in latestBySource"
              :key="`latest-${s.source}`"
              class="surface-1 rounded-md px-4 py-3 space-y-2"
            >
              <div class="flex items-baseline justify-between gap-2">
                <div class="min-w-0">
                  <div class="font-mono text-sm text-[var(--paper-1)] truncate">
                    {{ sourceLabel(s.source) }}
                  </div>
                  <div class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">
                    {{ sourceKindLabel(s.source) }}
                  </div>
                </div>
                <UBadge
                  :color="directionColor(s.signal)"
                  variant="soft"
                  class="font-mono text-[10px] uppercase tracking-[0.18em]"
                >
                  {{ s.signal }}
                </UBadge>
              </div>
              <div class="h-1 w-full bg-[var(--ink-2)] rounded overflow-hidden">
                <div class="h-full transition-all" :class="barClass(s.signal)" :style="{ width: pct(s.confidence) + '%' }" />
              </div>
              <div class="flex items-baseline justify-between font-mono text-[10px] text-[var(--paper-3)]">
                <span :class="pctClass(s.signal)" data-mono>{{ pct(s.confidence) }}%</span>
                <span>{{ relativeFromNow(s.ts) }}</span>
              </div>
            </div>
          </div>
        </section>

        <section v-if="signals.length > 0" class="space-y-3">
          <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
            filter
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="k in (['all', 'personas', 'analysts'] as FilterKind[])"
              :key="k"
              type="button"
              class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-1.5 rounded border hairline transition-colors"
              :class="kindFilter === k
                ? 'bg-[var(--ink-2)] text-[var(--paper-0)] border-[var(--ink-line-strong)]'
                : 'text-[var(--paper-3)] hover:text-[var(--paper-1)]'"
              @click="setKindFilter(k)"
            >
              {{ k }}
            </button>
            <span class="mx-2 h-4 w-px bg-[var(--ink-line)]" />
            <button
              v-for="src in allSources"
              :key="src"
              type="button"
              class="font-mono text-xs px-3 py-1.5 rounded border hairline transition-colors"
              :class="excludedSources.has(src)
                ? 'text-[var(--paper-3)] line-through opacity-60'
                : 'text-[var(--paper-1)] hover:text-[var(--accent)]'"
              @click="toggleSource(src)"
            >
              {{ sourceLabel(src) }}
            </button>
          </div>
        </section>

        <section v-if="filteredSignals.length > 0" class="space-y-6">
          <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
            timeline · {{ filteredSignals.length }} entries
          </div>
          <div
            v-for="group in groupedByDay"
            :key="group.key"
            class="space-y-3"
          >
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] border-b hairline pb-2">
              {{ group.label }}
            </div>
            <div class="space-y-2">
              <div
                v-for="s in group.signals"
                :key="s.id"
                class="surface-1 rounded-md px-5 py-3 space-y-2"
              >
                <div class="flex items-baseline justify-between gap-3">
                  <div class="flex items-baseline gap-3 min-w-0">
                    <span class="font-mono text-xs text-[var(--paper-3)]" data-mono>{{ formatTime(s.ts) }}</span>
                    <span class="font-mono text-sm text-[var(--paper-1)]">{{ sourceLabel(s.source) }}</span>
                    <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">
                      {{ sourceKindLabel(s.source) }}
                    </span>
                  </div>
                  <UBadge
                    :color="directionColor(s.signal)"
                    variant="soft"
                    class="font-mono text-[10px] uppercase tracking-[0.18em]"
                  >
                    {{ s.signal }}
                  </UBadge>
                </div>
                <div class="flex items-center gap-3">
                  <div class="h-1 flex-1 bg-[var(--ink-2)] rounded overflow-hidden">
                    <div class="h-full transition-all" :class="barClass(s.signal)" :style="{ width: pct(s.confidence) + '%' }" />
                  </div>
                  <span class="font-mono text-xs w-10 text-right" :class="pctClass(s.signal)" data-mono>
                    {{ pct(s.confidence) }}%
                  </span>
                </div>
                <p
                  class="text-sm text-[var(--paper-2)] leading-relaxed cursor-pointer whitespace-pre-wrap"
                  :class="expanded.has(s.id) ? '' : 'line-clamp-2'"
                  @click="toggleExpand(s.id)"
                >
                  {{ s.reasoning }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <div
          v-else-if="signals.length > 0"
          class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
        >
          no signals match the current filter.
        </div>

        <div
          v-else
          class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
        >
          no signals recorded for {{ symbol }} yet — run a research pass to populate.
        </div>
      </div>
    </main>
  </div>
</template>
