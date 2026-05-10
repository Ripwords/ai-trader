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

const { data: summary, refresh: refreshSummary } = await useFetch<{ symbols: SymbolSummary[] }>(
  '/api/research/symbols',
  { default: () => ({ symbols: [] }) },
)
const tiles = computed(() => summary.value?.symbols ?? [])

const search = ref('')
const trimmed = computed(() => search.value.trim().toUpperCase())
const canGo = computed(() => trimmed.value.length > 0)

function go() {
  if (!canGo.value) return
  navigateTo(`/research/${encodeURIComponent(trimmed.value)}`)
}

function ratingTone(r: string | null): 'up' | 'down' | 'neutral' {
  if (!r) return 'neutral'
  const v = r.toLowerCase()
  if (v === 'strong-buy' || v === 'buy') return 'up'
  if (v === 'reduce' || v === 'sell') return 'down'
  return 'neutral'
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return '—'
  const ms = Date.now() - then
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="page-header">
      <nav class="crumb" aria-label="breadcrumb">
        <span class="crumb__link crumb__link--leaf" aria-current="page">research</span>
      </nav>
      <div class="page-header__actions">
        <NuxtLink to="/research/runs" class="page-header__link">runs →</NuxtLink>
        <NuxtLink to="/algo" class="page-header__link">algo →</NuxtLink>
      </div>
    </header>

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
              v-model="search"
              placeholder="search NVDA, tencent, 600519…"
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
              @click="refreshSummary()"
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
                    :title="`run started ${fmtRelative(t.latestStartedAt)}`"
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
                  <span class="tile__time" data-mono>{{ fmtRelative(t.latestStartedAt) }}</span>
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
/* ─── Header / breadcrumb ─── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  height: 4rem;
  padding: 0 1.75rem;
  border-bottom: 1px solid var(--ink-line);
  flex-shrink: 0;
}
.crumb {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.crumb__link {
  color: var(--paper-3);
  text-decoration: none;
}
.crumb__link--leaf { color: var(--paper-0); }
.page-header__actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;
}
.page-header__link {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  text-decoration: none;
  transition: color 140ms ease;
}
.page-header__link:hover { color: var(--accent); }

/* ─── Layout ─── */
.landing {
  background:
    radial-gradient(ellipse at top, rgba(212, 169, 106, 0.025) 0%, transparent 55%),
    var(--ink-0);
}
.landing__inner {
  max-width: 1080px;
  margin: 0 auto;
  padding: 2.5rem 1.75rem 4rem;
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
.search__row > :global(*) { flex: 1 1 220px; }
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
</style>
