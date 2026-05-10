<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RiskReport } from '../../../../types/research'

definePageMeta({ section: 'research' })

const route = useRoute()
const symbol = computed(() => decodeURIComponent(route.params.symbol as string))

useHead({ title: () => `risk report · ${symbol.value}` })

const refreshKey = ref(0)
const { data, pending, error, refresh } = await useFetch<RiskReport>('/api/research/deep-report', {
  query: { symbol, refresh: refreshKey },
})

async function regenerate() {
  refreshKey.value = refreshKey.value === 0 ? 1 : 0
  await refresh()
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]" data-mono>{{ symbol }}</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]">risk report</span>
      </div>
      <div class="flex items-center gap-5">
        <button
          v-if="data"
          type="button"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
          :disabled="pending"
          @click="regenerate"
        >
          {{ pending ? 'regenerating…' : 'regenerate ↻' }}
        </button>
        <NuxtLink
          to="/research"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          ← research
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div v-if="pending && !data" class="loading">
        <div class="ring"><span /><span /><span /></div>
        <p>generating deep risk report for {{ symbol }} · this can take 30-60 seconds.</p>
      </div>

      <div v-else-if="error" class="error">
        <div class="mark">!</div>
        <p>{{ (error as { statusMessage?: string }).statusMessage ?? 'failed to generate report.' }}</p>
        <button type="button" class="retry" @click="regenerate">retry</button>
      </div>

      <div v-else-if="data" data-risk-report class="report">
        <PriceHeader
          :symbol="data.symbol"
          :name="data.name"
          :last="data.price.last"
          :change="data.price.change"
          :change-pct="data.price.change_pct"
          :currency="data.price.currency"
          :generated-at="data.generated_at"
          :cached="data.cached"
        />

        <div class="row two-up">
          <RiskGauge :score="data.risk_score" />
          <BottomLine :rating="data.rating" :bottom-line="data.bottom_line" />
        </div>

        <KpiStrip :kpis="data.kpis" />

        <PriceChart12mo :bars="data.chart.bars" :markers="data.chart.markers" />

        <ScoreBreakdown
          :valuation="data.valuation.score"
          :health="data.health.score"
          :growth="data.growth.score"
          :total="data.risk_score"
        />

        <div class="row three-up">
          <PillarGrid title="valuation" :pillar="data.valuation" />
          <PillarGrid title="health" :pillar="data.health" />
          <PillarGrid title="growth" :pillar="data.growth" />
        </div>

        <QuarterlyTrendTable :rows="data.quarterly" />

        <section v-if="data.earnings_update" class="earnings surface-1">
          <header>
            <span class="eyebrow">latest earnings update</span>
            <span class="date" data-mono>{{ data.earnings_update.date }}</span>
          </header>
          <h2>{{ data.earnings_update.headline }}</h2>
          <p v-if="data.earnings_update.body">{{ data.earnings_update.body }}</p>
        </section>

        <CatalystsRisks :catalysts="data.catalysts" :risks="data.risks" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.report {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.75rem 1.75rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.row { display: grid; gap: 1rem; }
.two-up { grid-template-columns: 1fr; }
.three-up { grid-template-columns: 1fr; }
@media (min-width: 900px) {
  .two-up { grid-template-columns: 320px 1fr; align-items: stretch; }
}
@media (min-width: 1024px) {
  .three-up { grid-template-columns: repeat(3, 1fr); }
}

.loading, .error {
  max-width: 520px;
  margin: 6rem auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
.error .mark {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  color: var(--tape-down);
}
.retry {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-1);
  background: transparent;
  border: 1px solid var(--ink-line-strong);
  padding: 0.55rem 1.1rem;
  border-radius: 4px;
  cursor: pointer;
}
.retry:hover { color: var(--accent); border-color: var(--accent); }

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

.earnings {
  border-radius: 6px;
  padding: 1.1rem 1.3rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.earnings header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.earnings .eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.earnings .date {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
.earnings h2 {
  font-family: var(--font-sans);
  font-size: 1rem;
  color: var(--paper-0);
  font-weight: 500;
}
.earnings p {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
</style>
