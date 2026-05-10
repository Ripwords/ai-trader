<script setup lang="ts">
import { computed, ref } from 'vue'

interface RunHistoryRow {
  costUsd: number | null
}

interface Props {
  symbol: string
  runHistory: RunHistoryRow[]
  /** A run is in-flight for this symbol (started from any tab, not just
   *  this one). Disables the Run button + shows a hint pointing at the
   *  live run, so the user can't accidentally fire a duplicate. */
  inFlight?: boolean
  /** Run-id of the in-flight run, if any. Used in the disabled-state hint. */
  inFlightRunId?: string | null
}

const props = defineProps<Props>()

/**
 * Knobs surfaced here mirror :class:`app.schemas.agents.RunRequest`. Defaults
 * pick the cheapest configuration that still produces a useful run; the user
 * tunes up explicitly when they want depth.
 */
export interface StartOpts {
  max_debate_rounds: number
  max_risk_discuss_rounds: number
  deep_thinking: boolean
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts: string[]
}

const emit = defineEmits<{
  start: [opts: StartOpts]
  /** Fired when the user clicks Cancel on the in-flight banner. The page
   *  routes this to the same DELETE-and-mark-cancelled flow the RunHeader
   *  uses, so cancelling here is identical to cancelling from inside the
   *  run view. */
  cancelInFlight: [runId: string]
}>()

// ─── Knob state ──────────────────────────────────────────────────────
const debateRounds = ref(1)
const riskRounds = ref(1)
const deepThinking = ref(true)
const reasoningEffort = ref<StartOpts['reasoning_effort']>('medium')
const responseLanguage = ref<StartOpts['response_language']>('en-US')

// Analyst selection — start with all four. Toggling off ``social`` cuts ~25%
// of the cost on a typical run; ``news`` saves another ~15%. Each toggle is
// a self-contained checkbox so the state is easy to reason about.
const analystState = ref<Record<string, boolean>>({
  market: true,
  social: true,
  news: true,
  fundamentals: true,
})

const analystList: { key: string; label: string; hint: string }[] = [
  { key: 'market',       label: 'market',       hint: 'price action + technicals (moomoo)' },
  { key: 'fundamentals', label: 'fundamentals', hint: 'balance sheet, cashflow, income (Yahoo)' },
  { key: 'news',         label: 'news',         hint: 'symbol + macro headlines (Tavily / Brave)' },
  { key: 'social',       label: 'social',       hint: 'sentiment scrape (LLM-only — slow + cheap-skip)' },
]

const selectedAnalysts = computed<string[]>(() =>
  analystList.map(a => a.key).filter(k => analystState.value[k] === true),
)

const enoughAnalysts = computed(() => selectedAnalysts.value.length > 0)

// ─── Cost estimate ───────────────────────────────────────────────────
const estimate = computed(() => {
  const samples = props.runHistory
    .map(r => r.costUsd)
    .filter((v): v is number => typeof v === 'number')
  if (samples.length === 0) {
    return { kind: 'static' as const, low: 0.30, high: 1.50 }
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
  const stdev = Math.sqrt(variance)
  return { kind: 'historical' as const, mean, stdev, n: samples.length }
})

const estimateText = computed(() => {
  // Adjust the historical mean by the analyst-selection ratio: the cost
  // scales roughly linearly with analyst count. Skipping social ~ -25%.
  const base = estimate.value
  const analystRatio = selectedAnalysts.value.length / analystList.length
  // Effort multiplier: low/medium/high/xhigh/max are roughly 0.6/1/1.6/2.4/3.5
  // on Anthropic's effort knob (token budget ratios). Apply softly.
  const effortMult = ({
    low:    0.7,
    medium: 1.0,
    high:   1.6,
    xhigh:  2.4,
    max:    3.5,
  } as const)[reasoningEffort.value]
  const debateMult = (debateRounds.value + riskRounds.value) / 2
  if (base.kind === 'static') {
    const low = base.low * analystRatio * effortMult * debateMult
    const high = base.high * analystRatio * effortMult * debateMult
    return `~$${low.toFixed(2)}–$${high.toFixed(2)}`
  }
  const m = base.mean * analystRatio * effortMult * debateMult
  return `~$${m.toFixed(2)} ± $${(base.stdev * analystRatio).toFixed(2)} (n=${base.n})`
})

function onStart() {
  if (!enoughAnalysts.value) return
  emit('start', {
    max_debate_rounds: debateRounds.value,
    max_risk_discuss_rounds: riskRounds.value,
    deep_thinking: deepThinking.value,
    reasoning_effort: reasoningEffort.value,
    response_language: responseLanguage.value,
    selected_analysts: selectedAnalysts.value,
  })
}
</script>

<template>
  <section class="cost">
    <header class="cost__head">
      <span class="cost__eyebrow">run agents</span>
      <span class="cost__symbol" data-mono>{{ symbol }}</span>
    </header>

    <div class="cost__estimate" data-mono>
      <span class="cost__estimate-label">estimated cost</span>
      <span class="cost__estimate-value">{{ estimateText }}</span>
    </div>

    <!-- Two columns of knobs: depth + scope on the left, model/lang on the right. -->
    <div class="cost__grid">
      <!-- Analyst selection -->
      <fieldset class="cost__fieldset cost__fieldset--span-2">
        <legend class="cost__legend">analysts</legend>
        <ul class="cost__analysts">
          <li
            v-for="a in analystList"
            :key="a.key"
            class="cost__analyst"
            :data-on="analystState[a.key]"
          >
            <label>
              <input
                v-model="analystState[a.key]"
                type="checkbox"
                class="cost__check"
              />
              <span class="cost__analyst-name" data-mono>{{ a.label }}</span>
              <span class="cost__analyst-hint">{{ a.hint }}</span>
            </label>
          </li>
        </ul>
        <p v-if="!enoughAnalysts" class="cost__warn" data-mono>
          ⚠ pick at least one analyst — pipeline can't run with none
        </p>
      </fieldset>

      <!-- Debate depth -->
      <fieldset class="cost__fieldset">
        <legend class="cost__legend">research debate · rounds</legend>
        <div class="cost__slider-row">
          <input
            v-model.number="debateRounds"
            type="range" min="1" max="3" step="1"
            class="cost__slider"
          />
          <span class="cost__slider-val" data-mono>{{ debateRounds }}</span>
        </div>
        <p class="cost__hint">bull vs bear iterations</p>
      </fieldset>

      <fieldset class="cost__fieldset">
        <legend class="cost__legend">risk debate · rounds</legend>
        <div class="cost__slider-row">
          <input
            v-model.number="riskRounds"
            type="range" min="1" max="3" step="1"
            class="cost__slider"
          />
          <span class="cost__slider-val" data-mono>{{ riskRounds }}</span>
        </div>
        <p class="cost__hint">aggressive · conservative · neutral</p>
      </fieldset>

      <!-- Reasoning effort -->
      <fieldset class="cost__fieldset">
        <legend class="cost__legend">reasoning effort</legend>
        <select v-model="reasoningEffort" class="cost__select" data-mono>
          <option value="low">low — fastest, cheapest</option>
          <option value="medium">medium — balanced (default)</option>
          <option value="high">high — deeper analysis</option>
          <option value="xhigh">xhigh — extended reasoning</option>
          <option value="max">max — maximum depth</option>
        </select>
      </fieldset>

      <!-- Response language -->
      <fieldset class="cost__fieldset">
        <legend class="cost__legend">response language</legend>
        <select v-model="responseLanguage" class="cost__select" data-mono>
          <option value="en-US">English (US)</option>
          <option value="zh-TW">繁體中文</option>
          <option value="zh-CN">简体中文</option>
          <option value="ja-JP">日本語</option>
          <option value="ko-KR">한국어</option>
          <option value="de-DE">Deutsch</option>
        </select>
      </fieldset>

      <!-- Deep thinking toggle (kept as quick on/off — overrides effort to minimal when off) -->
      <fieldset class="cost__fieldset cost__fieldset--span-2">
        <legend class="cost__legend">tier</legend>
        <label class="cost__deep">
          <input v-model="deepThinking" type="checkbox" class="cost__check" />
          <span class="cost__deep-text">
            <span class="cost__deep-name" data-mono>deep thinking</span>
            <span class="cost__deep-hint">trader / risk / researchers use the deep model. Off = single-pass quick model only ≈ 30% of cost.</span>
          </span>
        </label>
      </fieldset>
    </div>

    <!-- In-flight notice — appears when ANY run for this symbol is live
         (started from another tab, queued via cron, or still spinning
         from this session). Blocks the Run button to prevent duplicate
         spend, links to the live run, offers an inline cancel. -->
    <div v-if="inFlight" class="cost__live" role="status">
      <span class="cost__live-beacon" aria-hidden="true" />
      <span class="cost__live-text" data-mono>
        a run is already in flight
        <span v-if="inFlightRunId" class="cost__live-runid">
          · {{ inFlightRunId.slice(0, 8) }}
        </span>
      </span>
      <NuxtLink
        v-if="inFlightRunId"
        :to="{ path: `/research/${symbol}`, query: { run: inFlightRunId } }"
        class="cost__live-jump"
        data-mono
      >
        view →
      </NuxtLink>
      <button
        v-if="inFlightRunId"
        type="button"
        class="cost__live-cancel"
        @click="emit('cancelInFlight', inFlightRunId)"
      >
        <span data-mono>cancel</span>
      </button>
    </div>

    <button
      type="button"
      class="cost__run"
      :disabled="!enoughAnalysts || inFlight"
      :title="inFlight ? 'a run is already in flight; cancel it first' : ''"
      @click="onStart"
    >
      <span data-mono>{{ inFlight ? 'run pending' : 'transmit run' }}</span>
      <span class="cost__run-glyph" data-mono aria-hidden="true">→</span>
    </button>
  </section>
</template>

<style scoped>
.cost {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
  padding: 1.4rem 1.5rem 1.3rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: 4px;
  border-top: 3px solid var(--accent);
}

.cost__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.cost__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--accent);
}
.cost__symbol {
  font-size: 1rem;
  letter-spacing: 0.06em;
  color: var(--paper-0);
  text-transform: uppercase;
}

.cost__estimate {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  padding: 0.55rem 0.85rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-left: 2px solid var(--accent);
  border-radius: 3px;
  font-size: 0.8rem;
  flex-wrap: wrap;
}
.cost__estimate-label {
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.cost__estimate-value {
  color: var(--paper-0);
  font-variant-numeric: tabular-nums;
}

/* ─── Knob grid ─── */
.cost__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.85rem 1rem;
}
@media (max-width: 640px) {
  .cost__grid { grid-template-columns: 1fr; }
}
.cost__fieldset {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.cost__fieldset--span-2 { grid-column: 1 / -1; }
.cost__legend {
  font-family: var(--font-mono);
  font-size: 0.6rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding: 0;
}

/* ─── Analyst checkboxes ─── */
.cost__analysts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
}
@media (max-width: 640px) {
  .cost__analysts { grid-template-columns: 1fr; }
}
.cost__analyst label {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.4rem 0.55rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-radius: 3px;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}
.cost__analyst[data-on="true"] label { border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.cost__analyst label:hover { border-color: var(--accent); }
.cost__analyst-name {
  color: var(--paper-1);
  font-size: 0.8rem;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  font-weight: 500;
  flex-shrink: 0;
}
.cost__analyst[data-on="true"] .cost__analyst-name { color: var(--paper-0); }
.cost__analyst-hint {
  font-size: 0.66rem;
  color: var(--paper-3);
  flex: 1;
  line-height: 1.35;
}

.cost__check {
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 0;
}
.cost__warn {
  font-size: 0.7rem;
  color: var(--tape-down);
  margin: 0;
}

/* ─── Sliders ─── */
.cost__slider-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.cost__slider {
  flex: 1;
  accent-color: var(--accent);
}
.cost__slider-val {
  font-size: 0.95rem;
  color: var(--paper-0);
  font-variant-numeric: tabular-nums;
  min-width: 1.2rem;
  text-align: right;
}
.cost__hint {
  margin: 0;
  font-size: 0.66rem;
  color: var(--paper-3);
}

/* ─── Selects ─── */
.cost__select {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  padding: 0.45rem 0.55rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-radius: 3px;
  color: var(--paper-1);
  cursor: pointer;
}
.cost__select:focus { outline: 1px solid var(--accent); border-color: var(--accent); }

/* ─── Deep-thinking row ─── */
.cost__deep {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.55rem 0.7rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-radius: 3px;
  cursor: pointer;
}
.cost__deep:hover { border-color: var(--accent); }
.cost__deep-text {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.cost__deep-name {
  font-size: 0.8rem;
  color: var(--paper-0);
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-weight: 500;
}
.cost__deep-hint {
  font-size: 0.7rem;
  color: var(--paper-3);
  line-height: 1.45;
  max-width: 70ch;
}

/* ─── In-flight notice ─── */
.cost__live {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.8rem;
  background: rgba(212, 169, 106, 0.06);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  border-left: 2px solid var(--accent);
  border-radius: 3px;
  flex-wrap: wrap;
}
.cost__live-beacon {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.55);
  animation: live-beacon 1.4s ease-out infinite;
  flex-shrink: 0;
}
@keyframes live-beacon {
  0%   { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.55); }
  70%  { box-shadow: 0 0 0 7px rgba(212, 169, 106, 0); }
  100% { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0); }
}
.cost__live-text {
  flex: 1;
  font-size: 0.78rem;
  color: var(--paper-1);
  letter-spacing: 0.02em;
}
.cost__live-runid {
  color: var(--paper-3);
  font-variant-numeric: tabular-nums;
}
.cost__live-jump {
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
  text-decoration: none;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: 2px;
  padding: 0.25rem 0.55rem;
  transition: background-color 140ms ease, border-color 140ms ease;
}
.cost__live-jump:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: var(--accent);
}
.cost__live-cancel {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--ink-line-strong);
  border-radius: 2px;
  background: transparent;
  color: var(--paper-2);
  cursor: pointer;
  transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease;
}
.cost__live-cancel:hover {
  color: var(--tape-down);
  border-color: var(--tape-down);
  background: rgba(224, 122, 95, 0.06);
}

/* ─── Run button ─── */
.cost__run {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  padding: 0.7rem 1.2rem;
  border-radius: 3px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--ink-0);
  cursor: pointer;
  transition: background-color 200ms ease, transform 120ms ease;
  font-weight: 500;
}
.cost__run:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, white);
}
.cost__run:active:not(:disabled) { transform: translateY(1px); }
.cost__run:disabled {
  background: transparent;
  color: var(--paper-3);
  border-color: var(--ink-line-strong);
  cursor: not-allowed;
}
.cost__run-glyph { font-size: 1rem; }
</style>
