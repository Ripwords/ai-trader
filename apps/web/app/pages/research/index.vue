<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: breadcrumb header, ticker search, research-intelligence figures and queue, researched-ticker grid · design-system: design.md · designed-as-app */
import { computed, ref } from 'vue'
import { apiErrorMessage } from '~/lib/api-error'
import { fmtConfidence, fmtUsd, ratingTone, toIso } from '~/utils/research-view'

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
  action: 'monitor_running' | 'rerun_failed' | 'refresh_stale' | 'none'
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

const {
  data: summary, refresh: refreshSummary, status: summaryStatus, error: summaryError,
} = await useFetch<{ symbols: SymbolSummary[] }>('/api/research/symbols')
const {
  data: intelligence, refresh: refreshIntelligence, status: intelStatus, error: intelError,
} = await useFetch<ResearchIntelligence>('/api/research/intelligence')

const tiles = computed(() => summary.value?.symbols ?? [])
const queue = computed(() => intelligence.value?.queue.slice(0, 4) ?? [])
const intelFigures = computed(() => {
  const s = intelligence.value?.summary
  if (!s) return []
  return [
    { label: 'symbols', value: String(s.total_symbols) },
    { label: 'running', value: String(s.running_symbols) },
    { label: 'stale', value: String(s.stale_symbols) },
    { label: 'failed 7d', value: String(s.failed_runs_7d) },
    { label: 'avg conf', value: fmtConfidence(s.avg_confidence) },
  ]
})

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

const SEVERITY_TONE = { high: 'down', medium: 'accent', low: 'neutral' } as const

function actionLabel(action: IntelligenceQueueItem['action']): string {
  if (action === 'monitor_running') return 'monitor'
  if (action === 'rerun_failed') return 'rerun'
  if (action === 'refresh_stale') return 'refresh'
  return 'current'
}

function refreshAll() {
  void refreshSummary()
  void refreshIntelligence()
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
        <NuxtLink to="/research/runs" class="text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors">all runs</NuxtLink>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden landing">
      <div class="landing__inner">

        <section class="landing__intro">
          <h1 class="landing__title">pick a ticker</h1>
          <p class="landing__lede">
            analysts, then a bull/bear debate, a trader and a risk gate. one verdict, full timeline.
          </p>
        </section>

        <section class="search">
          <label class="search__row">
            <span class="label-eyebrow search__label">symbol</span>
            <SymbolSearchInput
              :model-value="search"
              placeholder="search NVDA, tencent, 600519…"
              @update:model-value="onInput"
              @select="onSelect"
              @submit="canGo && go()"
            />
            <button
              type="button"
              class="search__btn tap"
              :disabled="!canGo"
              @click="go()"
            >
              <span data-mono>open · {{ trimmed || '—' }}</span>
              <UIcon name="i-lucide-arrow-right" class="search__btn-icon" aria-hidden="true" />
            </button>
          </label>
        </section>

        <section class="intel">
          <header class="intel__head">
            <span class="label-eyebrow">research intelligence</span>
            <span v-if="intelligence" class="intel__cost" data-mono>
              30d cost {{ fmtUsd(intelligence.summary.total_cost_30d) }}
            </span>
          </header>
          <PageState v-if="intelStatus === 'pending' && !intelligence" kind="loading" message="loading research intelligence…" />
          <PageState
            v-else-if="intelError"
            kind="error"
            :message="apiErrorMessage(intelError, 'could not load research intelligence')"
            @retry="refreshIntelligence()"
          />
          <template v-else-if="intelligence">
            <div class="intel__stats">
              <StatTile v-for="f in intelFigures" :key="f.label" :label="f.label" :value="f.value" />
            </div>
            <div v-if="queue.length > 0" class="intel__queue">
              <NuxtLink
                v-for="item in queue"
                :key="`${item.symbol}-${item.action}`"
                :to="`/research/${encodeURIComponent(item.symbol)}`"
                class="intel__item"
              >
                <span class="intel__lead">
                  <span class="tone-dot" :class="`tone-dot--${SEVERITY_TONE[item.severity]}`" :aria-label="`${item.severity} priority`" role="img" />
                  <span class="intel__symbol" data-mono>{{ item.symbol }}</span>
                </span>
                <span class="intel__action" data-mono>{{ actionLabel(item.action) }}</span>
                <span class="intel__note">{{ item.note }}</span>
              </NuxtLink>
            </div>
            <p v-else class="intel__empty" data-mono>
              research queue clear
            </p>
          </template>
        </section>

        <section class="tiles">
          <header class="tiles__head">
            <span class="label-eyebrow tiles__eyebrow">your tickers</span>
            <span v-if="summary" class="tiles__count" data-mono>
              {{ tiles.length }} symbol{{ tiles.length === 1 ? '' : 's' }}
            </span>
            <UButton
              variant="ghost"
              color="neutral"
              size="sm"
              icon="i-lucide-refresh-cw"
              class="tap font-mono"
              :loading="summaryStatus === 'pending' || intelStatus === 'pending'"
              @click="refreshAll()"
            >
              refresh
            </UButton>
          </header>

          <PageState v-if="summaryStatus === 'pending' && !summary" kind="loading" message="loading your tickers…" />
          <PageState
            v-else-if="summaryError"
            kind="error"
            :message="apiErrorMessage(summaryError, 'could not load your tickers')"
            @retry="refreshSummary()"
          />
          <ol v-else-if="tiles.length > 0" class="tiles__grid">
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
                    role="img"
                    aria-label="run in progress"
                  />
                </header>

                <div class="tile__verdict" :data-tone="ratingTone(t.latestRating)">
                  <span class="tone-dot" :class="`tone-dot--${t.latestRating ? ratingTone(t.latestRating) : 'neutral'}`" aria-hidden="true" />
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
                  >{{ fmtConfidence(t.latestConfidence) }}</span>
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
          <PageState v-else kind="empty" message="no agent runs yet. pick a ticker above to start one." />
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
}
.crumb__link {
  color: var(--paper-3);
  text-decoration: none;
}
.crumb__link--leaf { color: var(--paper-0); }

/* ─── Layout ─── */
.landing {
  background:
    radial-gradient(ellipse at top, color-mix(in srgb, var(--accent) 2.5%, transparent) 0%, transparent 55%),
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
  border-radius: var(--radius-card);
}
.search__row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}
.search__label { flex: 0 0 auto !important; }
.search__row > :deep(*) { flex: 1 1 220px; }
.search__btn {
  flex: 0 0 auto !important;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 40px;
  padding: 0.55rem 1rem;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  color: var(--ink-0);
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 140ms ease;
}
.search__btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, var(--paper-0));
}
.search__btn:disabled {
  background: transparent;
  color: var(--paper-3);
  border-color: var(--ink-line-strong);
  cursor: not-allowed;
}
.search__btn-icon { width: 1rem; height: 1rem; }

/* ─── Shared tone dot ─── */
.tone-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: var(--paper-3);
}
.tone-dot--up { background: var(--tape-up); }
.tone-dot--down { background: var(--tape-down); }
.tone-dot--accent { background: var(--accent); }
.tone-dot--neutral { background: var(--paper-3); }

/* ─── Intelligence queue ─── */
.intel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem 1.2rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: var(--radius-card);
}
.intel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.intel__cost {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.intel__stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 1rem;
}
.intel__queue {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
}
.intel__item {
  display: grid;
  grid-template-columns: 96px 72px minmax(0, 1fr);
  gap: 0.65rem;
  align-items: center;
  min-height: 44px;
  padding: 0.6rem 0.75rem;
  color: var(--paper-1);
  text-decoration: none;
  border: 1px solid var(--ink-line);
  border-radius: var(--radius-sm);
  transition: border-color 140ms ease;
}
.intel__item:hover { border-color: var(--accent); }
.intel__lead {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}
.intel__symbol {
  font-family: var(--font-mono);
  color: var(--paper-0);
}
.intel__action {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
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
  align-items: center;
  gap: 1rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--ink-line);
}
.tiles__eyebrow { flex: 1; }
.tiles__count {
  font-size: 11px;
  color: var(--paper-3);
  letter-spacing: 0.06em;
}

.tiles__grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.7rem;
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
  border-radius: var(--radius-card);
  text-decoration: none;
  transition: border-color 160ms ease, background-color 160ms ease;
  height: 100%;
}
.tile[data-inflight="true"] .tile__link {
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 4%, transparent) 0%, var(--ink-1) 80%);
}
.tile__link:hover { border-color: var(--accent); }

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
  animation: tile-beacon 1.4s ease-in-out infinite;
  flex-shrink: 0;
}
@keyframes tile-beacon {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

.tile__verdict {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.tile__rating {
  font-size: 0.85rem;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--paper-1);
  font-weight: 500;
}
.tile__verdict[data-tone="up"]      .tile__rating { color: var(--tape-up); }
.tile__verdict[data-tone="down"]    .tile__rating { color: var(--tape-down); }
.tile__rating--pending { color: var(--paper-3); }
.tile__confidence {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--paper-2);
  font-variant-numeric: tabular-nums;
}

.tile__foot {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--paper-3);
}
.tile__sep { color: var(--paper-3); }
.tile__time { color: var(--paper-2); }

@media (max-width: 760px) {
  .intel__stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .intel__queue {
    grid-template-columns: 1fr;
  }
  .intel__item {
    grid-template-columns: 96px minmax(0, 1fr);
  }
  .intel__note {
    grid-column: 1 / -1;
  }
}
@media (max-width: 640px) {
  .intel__stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (pointer: coarse) {
  .search__btn { min-height: 44px; }
}
</style>
