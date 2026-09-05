<script setup lang="ts">
// Research landing page. Two affordances:
//   1. Symbol search (top): jump straight to a ticker — same flow as before.
//   2. "Tickers I've researched" tile grid (below): renders one card per
//      distinct symbol that has at least one agent_runs row, sorted by
//      most-recent activity. Each tile is a deep-link to the per-symbol
//      view, with a live-run beacon when a run is currently in flight.
//
// Data comes from /api/research/symbols (owner-scoped per-symbol aggregate).

import { computed, ref } from 'vue'

definePageMeta({ section: 'research' })
useHead({ title: 'research' })

interface SymbolSummary {
  symbol: string
  runCount: number
  completeCount: number
  hasInflight: boolean
  latestStartedAt: string
  latestRating: string | null
  latestConfidence: number | null
}

interface IntelligenceQueueItem {
  symbol: string
  action: 'monitor_running' | 'rerun_failed' | 'review_thesis' | 'refresh_stale' | 'none'
  severity: 'high' | 'medium' | 'low'
  note: string
  latest_run_id: string
  latest_started_at: string
  latest_rating: string | null
  latest_confidence: number | null
  days_since_complete: number | null
}

interface ResearchIntelligence {
  summary: {
    total_symbols: number
    running_symbols: number
    stale_symbols: number
    failed_runs_7d: number
    avg_confidence: number | null
    total_cost_30d: number
  }
  queue: IntelligenceQueueItem[]
}

const { data: summary, refresh: refreshSummary } = await useFetch<{ symbols: SymbolSummary[] }>(
  '/api/research/symbols',
  { default: () => ({ symbols: [] }) },
)
const { data: intelligence, refresh: refreshIntelligence } = await useFetch<ResearchIntelligence>(
  '/api/research/intelligence',
  {
    default: () => ({
      summary: {
        total_symbols: 0,
        running_symbols: 0,
        stale_symbols: 0,
        failed_runs_7d: 0,
        avg_confidence: null,
        total_cost_30d: 0,
      },
      queue: [],
    }),
  },
)
const tiles = computed(() => summary.value?.symbols ?? [])
const queue = computed(() => intelligence.value?.queue.slice(0, 4) ?? [])

const search = ref('')
// Canonical moomoo symbol captured when the user picks from the searcher.
// Cleared whenever the text changes so a stale pick can't ride along with
// re-typed text. See docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
const picked = ref<string | null>(null)
const trimmed = computed(() => search.value.trim().toUpperCase())
const canGo = computed(() => trimmed.value.length > 0)

function onSelect(hit: { moomoo: string | null, yahoo: string }) {
  picked.value = hit.moomoo ?? hit.yahoo
}
function onInput(v: string) {
  search.value = v
  picked.value = null
}

function go() {
  if (!canGo.value) return
  // Prefer the canonical symbol from an explicit pick. Free-typed text still
  // navigates — the proxy hard-gates it server-side (422) and the per-symbol
  // page renders a resolver picker instead of a cryptic failure.
  const target = picked.value ?? trimmed.value
  navigateTo(`/research/${encodeURIComponent(target)}`)
}

function ratingTone(r: string | null): 'up' | 'down' | 'neutral' {
  if (!r) return 'neutral'
  const v = r.toLowerCase()
  if (v === 'strong-buy' || v === 'buy') return 'up'
  if (v === 'reduce' || v === 'sell') return 'down'
  return 'neutral'
}

function actionLabel(action: IntelligenceQueueItem['action']): string {
  if (action === 'monitor_running') return 'monitor'
  if (action === 'rerun_failed') return 'rerun'
  if (action === 'review_thesis') return 'review'
  if (action === 'refresh_stale') return 'refresh'
  return 'current'
}

function refreshAll() {
  refreshSummary()
  refreshIntelligence()
}

// Postgres serialises timestamps as ``2026-05-10 15:35:40.874689+00``
// which ``new Date(...)`` accepts but ``<NuxtTime>`` is happier with a
// proper ISO 8601 string. Coerce once here.
function toIso(s: string | null): string | null {
  if (!s) return null
  // Already ISO-ish (has ``T``)? Pass through.
  if (s.includes('T')) return s
  return s.replace(' ', 'T').replace(/\+00$/, 'Z')
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <nav class="crumb" aria-label="breadcrumb">
          <span class="crumb__link crumb__link--leaf" aria-current="page">research</span>
        </nav>
      </template>
      <template #actions>
        <NuxtLink to="/research/runs" class="text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors">runs →</NuxtLink>
        <NuxtLink to="/algo" class="text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors">algo →</NuxtLink>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden landing">
      <div class="landing__inner">

        <!-- ─── Search affordance ─── -->
        <section class="landing__intro">
          <span class="landing__eyebrow">agents · multi-agent debate</span>
          <h1 class="landing__title">pick a ticker</h1>
          <p class="landing__lede">
            analysts → bull/bear debate → trader → risk gate. one verdict, full timeline.
          </p>
        </section>

        <section class="search">
          <label class="search__row">
            <span class="search__label">symbol</span>
            <SymbolSearchInput
              :model-value="search"
              placeholder="search NVDA, tencent, 600519…"
              @update:model-value="onInput"
              @select="onSelect"
              @submit="canGo && go()"
            />
            <button
              type="button"
              class="search__btn"
              :disabled="!canGo"
              @click="go()"
            >
              <span data-mono>open · {{ trimmed || '—' }}</span>
              <span class="search__btn-glyph" data-mono aria-hidden="true">→</span>
            </button>
          </label>
        </section>

        <section class="intel">
          <header class="intel__head">
            <span class="intel__eyebrow">research intelligence</span>
            <span class="intel__cost" data-mono>
              30d cost ${{ intelligence?.summary.total_cost_30d.toFixed(2) ?? '0.00' }}
            </span>
          </header>
          <div class="intel__stats">
            <div>
              <span class="intel__stat-label">symbols</span>
              <strong data-mono>{{ intelligence?.summary.total_symbols ?? 0 }}</strong>
            </div>
            <div>
              <span class="intel__stat-label">running</span>
              <strong data-mono>{{ intelligence?.summary.running_symbols ?? 0 }}</strong>
            </div>
            <div>
              <span class="intel__stat-label">stale</span>
              <strong data-mono>{{ intelligence?.summary.stale_symbols ?? 0 }}</strong>
            </div>
            <div>
              <span class="intel__stat-label">failed 7d</span>
              <strong data-mono>{{ intelligence?.summary.failed_runs_7d ?? 0 }}</strong>
            </div>
            <div>
              <span class="intel__stat-label">avg conf</span>
              <strong data-mono>{{ intelligence?.summary.avg_confidence ?? '—' }}{{ intelligence?.summary.avg_confidence == null ? '' : '%' }}</strong>
            </div>
          </div>
          <div v-if="queue.length > 0" class="intel__queue">
            <NuxtLink
              v-for="item in queue"
              :key="`${item.symbol}-${item.action}`"
              :to="`/research/${encodeURIComponent(item.symbol)}`"
              class="intel__item"
              :data-severity="item.severity"
            >
              <span class="intel__symbol" data-mono>{{ item.symbol }}</span>
              <span class="intel__action" data-mono>{{ actionLabel(item.action) }}</span>
              <span class="intel__note">{{ item.note }}</span>
            </NuxtLink>
          </div>
          <p v-else class="intel__empty" data-mono>
            research queue clear
          </p>
        </section>

        <!-- ─── Tickers with prior runs ─── -->
        <section class="tiles">
          <header class="tiles__head">
            <span class="tiles__eyebrow">your tickers</span>
            <span class="tiles__count" data-mono>
              {{ tiles.length }} symbol{{ tiles.length === 1 ? '' : 's' }}
            </span>
            <button
              type="button"
              class="tiles__refresh"
              data-mono
              @click="refreshAll()"
            >
              ↻ refresh
            </button>
          </header>

          <ol v-if="tiles.length > 0" class="tiles__grid">
            <li
              v-for="t in tiles"
              :key="t.symbol"
              class="tile"
              :data-inflight="t.hasInflight"
            >
              <NuxtLink :to="`/research/${encodeURIComponent(t.symbol)}`" class="tile__link">
                <header class="tile__head">
                  <span class="tile__symbol" data-mono>{{ t.symbol }}</span>
                  <span
                    v-if="t.hasInflight"
                    class="tile__beacon"
                    :title="`run started ${toIso(t.latestStartedAt) ?? ''}`"
                    aria-label="run in progress"
                  />
                </header>

                <div class="tile__verdict" :data-tone="ratingTone(t.latestRating)">
                  <span v-if="t.latestRating" class="tile__rating" data-mono>
                    {{ t.latestRating }}
                  </span>
                  <span v-else class="tile__rating tile__rating--pending" data-mono>
                    {{ t.hasInflight ? 'running' : 'pending' }}
                  </span>
                  <span
                    v-if="t.latestConfidence !== null"
                    class="tile__confidence"
                    data-mono
                  >{{ t.latestConfidence }}%</span>
                </div>

                <footer class="tile__foot">
                  <span class="tile__count" data-mono>
                    {{ t.runCount }} run{{ t.runCount === 1 ? '' : 's' }}
                  </span>
                  <span class="tile__sep" aria-hidden="true">·</span>
                  <NuxtTime
                    v-if="toIso(t.latestStartedAt)"
                    :datetime="toIso(t.latestStartedAt) as string"
                    relative
                    numeric="auto"
                    class="tile__time"
                    data-mono
                  />
                  <span v-else class="tile__time" data-mono>—</span>
                </footer>
              </NuxtLink>
            </li>
          </ol>

          <p v-else class="tiles__empty" data-mono>
            no agent runs yet — pick a ticker above to start
          </p>
        </section>

      </div>
    </main>
  </div>
</template>

<style scoped>
/* ─── Breadcrumb ─── */
.crumb {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.crumb__link {
  color: var(--paper-3);
  text-decoration: none;
}
.crumb__link--leaf { color: var(--paper-0); }

/* ─── Layout ─── */
.landing {
  background:
    radial-gradient(ellipse at top, rgba(212, 169, 106, 0.025) 0%, transparent 55%),
    var(--ink-0);
}
.landing__inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 2.5rem var(--page-x) 4rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

/* ─── Intro ─── */
.landing__intro {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.landing__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent);
}
.landing__title {
  margin: 0;
  font-size: 1.65rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--paper-0);
}
.landing__lede {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.82rem;
  color: var(--paper-2);
  letter-spacing: 0.005em;
  line-height: 1.55;
  max-width: 60ch;
}

/* ─── Search ─── */
.search {
  padding: 1rem 1.2rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: 4px;
}
.search__row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}
.search__label {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
  flex-shrink: 0;
}
.search__row > :deep(*) { flex: 1 1 220px; }
.search__btn {
  flex: 0 0 auto !important;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--ink-0);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 3px;
  cursor: pointer;
  transition: background-color 140ms ease;
}
.search__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, white);
}
.search__btn:disabled {
  background: transparent;
  color: var(--paper-3);
  border-color: var(--ink-line-strong);
  cursor: not-allowed;
}
.search__btn-glyph { font-size: 0.95rem; }

/* ─── Intelligence queue ─── */
.intel {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  padding: 1rem 1.2rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: 4px;
}
.intel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.intel__eyebrow,
.intel__cost,
.intel__stat-label,
.intel__action {
  font-family: var(--font-mono);
  text-transform: uppercase;
}
.intel__eyebrow {
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  color: var(--paper-3);
}
.intel__cost {
  font-size: 0.68rem;
  letter-spacing: 0.14em;
  color: var(--paper-3);
}
.intel__stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 0.75rem;
}
.intel__stats > div {
  padding: 0.75rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
}
.intel__stat-label {
  display: block;
  font-size: 0.62rem;
  letter-spacing: 0.16em;
  color: var(--paper-3);
}
.intel__stats strong {
  display: block;
  margin-top: 0.35rem;
  font-size: 1.1rem;
  color: var(--paper-0);
}
.intel__queue {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
}
.intel__item {
  display: grid;
  grid-template-columns: 76px 72px minmax(0, 1fr);
  gap: 0.65rem;
  align-items: center;
  padding: 0.75rem;
  color: var(--paper-1);
  text-decoration: none;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-left-width: 2px;
}
.intel__item[data-severity="high"] { border-left-color: var(--tape-down); }
.intel__item[data-severity="medium"] { border-left-color: var(--accent); }
.intel__symbol {
  font-family: var(--font-mono);
  color: var(--paper-0);
}
.intel__action {
  font-size: 0.62rem;
  letter-spacing: 0.13em;
  color: var(--accent);
}
.intel__note {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--paper-2);
  font-size: 0.82rem;
}
.intel__empty {
  margin: 0;
  color: var(--paper-3);
  font-size: 0.78rem;
}

/* ─── Tiles ─── */
.tiles {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.tiles__head {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--ink-line);
}
.tiles__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--paper-3);
  flex: 1;
}
.tiles__count {
  font-size: 0.7rem;
  color: var(--paper-3);
  letter-spacing: 0.18em;
  text-transform: uppercase;
}
.tiles__refresh {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  background: transparent;
  border: 0;
  color: var(--paper-3);
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  transition: color 140ms ease;
}
.tiles__refresh:hover { color: var(--accent); }

.tiles__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.7rem;
}
.tiles__empty {
  margin: 0;
  padding: 2.5rem 1.2rem;
  text-align: center;
  font-size: 0.78rem;
  color: var(--paper-3);
  letter-spacing: 0.04em;
  border: 1px dashed var(--ink-line-strong);
  border-radius: 4px;
}

.tile {
  position: relative;
  list-style: none;
}
.tile__link {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1rem 1.1rem 0.9rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: 4px;
  text-decoration: none;
  transition: border-color 160ms ease, transform 160ms ease, background-color 160ms ease;
  height: 100%;
}
.tile[data-inflight="true"] .tile__link {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: linear-gradient(180deg, rgba(212, 169, 106, 0.04) 0%, var(--ink-1) 80%);
}
.tile__link:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

.tile__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}
.tile__symbol {
  font-size: 1rem;
  letter-spacing: 0.06em;
  color: var(--paper-0);
  text-transform: uppercase;
  font-weight: 500;
}
.tile__beacon {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.55);
  animation: tile-beacon 1.4s ease-out infinite;
  flex-shrink: 0;
}
@keyframes tile-beacon {
  0%   { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.55); }
  70%  { box-shadow: 0 0 0 7px rgba(212, 169, 106, 0); }
  100% { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0); }
}

.tile__verdict {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.45rem 0.7rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-left: 2px solid var(--paper-3);
  border-radius: 3px;
}
.tile__verdict[data-tone="up"]      { border-left-color: var(--tape-up); }
.tile__verdict[data-tone="down"]    { border-left-color: var(--tape-down); }
.tile__verdict[data-tone="neutral"] { border-left-color: var(--accent); }
.tile__rating {
  font-size: 0.85rem;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--paper-1);
  font-weight: 500;
}
.tile__verdict[data-tone="up"]      .tile__rating { color: var(--tape-up); }
.tile__verdict[data-tone="down"]    .tile__rating { color: var(--tape-down); }
.tile__verdict[data-tone="neutral"] .tile__rating { color: var(--accent); }
.tile__rating--pending { color: var(--paper-3); font-style: italic; }
.tile__confidence {
  margin-left: auto;
  font-size: 0.74rem;
  color: var(--paper-2);
  font-variant-numeric: tabular-nums;
}

.tile__foot {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 0.66rem;
  letter-spacing: 0.06em;
  color: var(--paper-3);
}
.tile__count {
  text-transform: uppercase;
  letter-spacing: 0.18em;
}
.tile__sep { color: var(--ink-line-strong); }
.tile__time { color: var(--paper-2); }

@media (max-width: 760px) {
  .intel__stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .intel__queue {
    grid-template-columns: 1fr;
  }
  .intel__item {
    grid-template-columns: 72px minmax(0, 1fr);
  }
  .intel__note {
    grid-column: 1 / -1;
  }
}
@media (max-width: 640px) {
  /* Three 0.62rem tracked labels ("failed 7d") no longer fit their cell once
     the card padding is subtracted from a 320px viewport. */
  .intel__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (pointer: coarse) {
  .search__btn { min-height: 44px; }
  /* .tiles__head is baseline-aligned, so a 44px-tall button would drag the
     row's baseline. Grow the hit area with an overlay, not the box. */
  .tiles__refresh { position: relative; }
  .tiles__refresh::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
    min-width: 44px;
    height: 44px;
  }
}
</style>
