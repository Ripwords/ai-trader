<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { AgentEvent } from '../../../types/agents'

interface Props {
  status: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled'
  events: AgentEvent[]
  elapsedSec: number
  symbol: string
  runId: string | null
}
const props = defineProps<Props>()
const emit = defineEmits<{ cancel: [] }>()

// ─── Last-event clock ───────────────────────────────────────────────
// Records the wall-clock at which we last saw any event flow in. Drives
// the "no signal for X seconds" stuck hint — if the LLM is hung waiting
// on a slow provider, this counter ticks up while ``elapsedSec`` keeps
// rising too. The two together let the user distinguish "still working"
// from "really stuck".
const lastEventAt = ref<number | null>(null)
const sinceLastEventSec = ref(0)
let tick: ReturnType<typeof setInterval> | null = null

watch(
  () => props.events.length,
  () => {
    lastEventAt.value = Date.now()
    sinceLastEventSec.value = 0
  },
)

watch(
  () => props.status,
  (s) => {
    if (s === 'running') {
      if (lastEventAt.value === null) lastEventAt.value = Date.now()
      if (tick) clearInterval(tick)
      tick = setInterval(() => {
        if (lastEventAt.value !== null) {
          sinceLastEventSec.value = Math.floor((Date.now() - lastEventAt.value) / 1000)
        }
      }, 1000)
    }
    else if (tick) {
      clearInterval(tick)
      tick = null
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  if (tick) clearInterval(tick)
  tick = null
})

// ─── Activity readout ──────────────────────────────────────────────
const activeNode = computed(() => {
  for (let i = props.events.length - 1; i >= 0; i--) {
    const ev = props.events[i]
    if (ev?.type === 'node-start') return ev.node
  }
  return null
})

const lastTool = computed(() => {
  for (let i = props.events.length - 1; i >= 0; i--) {
    const ev = props.events[i]
    if (ev?.type === 'tool-call' || ev?.type === 'tool-result') return ev
  }
  return null
})

const activityLine = computed(() => {
  const tool = lastTool.value
  const node = activeNode.value
  if (tool) {
    const icon = tool.type === 'tool-call' ? 'i-lucide-arrow-right' : 'i-lucide-arrow-left'
    return { node, icon, tool: tool.tool }
  }
  if (node) return { node, icon: null, tool: 'thinking' }
  if (props.events.length === 0) return { node: null, icon: null, tool: 'spinning up' }
  return { node, icon: null, tool: '—' }
})

// ─── Stuck hint thresholds ─────────────────────────────────────────
// 30s of silence: hint appears, low-key.
// 60s of silence: hint elevates to "likely stuck" with cancel CTA.
const stuckLevel = computed<'ok' | 'soft' | 'hard'>(() => {
  if (props.status !== 'running') return 'ok'
  if (sinceLastEventSec.value >= 60) return 'hard'
  if (sinceLastEventSec.value >= 30) return 'soft'
  return 'ok'
})

// Format elapsed like a tape readout: 0:00 / 1:34 / 12:07.
const elapsedFmt = computed(() => {
  const t = Math.max(0, Math.floor(props.elapsedSec))
  const m = Math.floor(t / 60)
  const s = (t % 60).toString().padStart(2, '0')
  return `${m}:${s}`
})

const statusLabel = computed(() => {
  if (props.status === 'running') return 'TRANSMITTING'
  if (props.status === 'complete') return 'COMPLETE'
  if (props.status === 'failed') return 'FAILED'
  if (props.status === 'cancelled') return 'CANCELLED'
  return 'IDLE'
})
</script>

<template>
  <header
    v-if="status !== 'idle'"
    class="run-header"
    :data-status="status"
    :data-stuck="stuckLevel"
  >
    <div class="run-header__row">
      <!-- Left: status label + symbol. Symbol is the loud thing here. -->
      <div class="run-header__lead">
        <span class="run-header__status">
          <span v-if="status === 'running'" class="run-header__beacon" />
          {{ statusLabel }}
        </span>
        <span class="run-header__symbol">{{ symbol }}</span>
      </div>

      <!-- Center: elapsed time as a tape readout. The big number on the page. -->
      <div class="run-header__elapsed" data-mono>
        <span class="run-header__elapsed-value">{{ elapsedFmt }}</span>
        <span class="run-header__elapsed-unit">elapsed</span>
      </div>

      <!-- Right: cancel + meta. Cancel only when running. -->
      <div class="run-header__actions">
        <span class="run-header__events" data-mono>
          {{ events.length }} ev
        </span>
        <button
          v-if="status === 'running'"
          type="button"
          class="run-header__cancel"
          :data-urgent="stuckLevel === 'hard'"
          @click="emit('cancel')"
        >
          cancel
        </button>
      </div>
    </div>

    <!-- Activity line: who's working, what they're doing, when we last heard. -->
    <div class="run-header__activity" :data-quiet="status !== 'running'">
      <span v-if="activityLine.node" class="run-header__activity-node">
        {{ activityLine.node.replace(/_/g, ' ') }}
      </span>
      <UIcon v-if="activityLine.icon" :name="activityLine.icon" class="run-header__activity-icon" aria-hidden="true" />
      <span v-else class="run-header__activity-glyph" data-mono>
        ·
      </span>
      <span class="run-header__activity-tool" data-mono>
        {{ activityLine.tool }}
      </span>
      <span
        v-if="status === 'running' && sinceLastEventSec > 5"
        class="run-header__since"
        data-mono
        :data-stuck="stuckLevel"
      >
        {{ sinceLastEventSec }}s since last
      </span>
    </div>

    <!-- Stuck hint, escalates with stuckLevel. -->
    <div
      v-if="stuckLevel !== 'ok'"
      class="run-header__stuck"
      :data-level="stuckLevel"
      role="status"
    >
      <span v-if="stuckLevel === 'soft'">
        no events for {{ sinceLastEventSec }}s — LLM call probably mid-flight.
        DeepSeek and similar can take 30–90s on a single tool round.
      </span>
      <span v-else>
        no events for {{ sinceLastEventSec }}s — likely hung. cancel and re-run if it
        doesn't recover.
      </span>
    </div>
  </header>
</template>

<style scoped>
.run-header {
  position: sticky;
  top: 0;
  z-index: 10;
  /* Solid background — earlier I had a fade-to-transparent at the bottom for
     a "soft" effect, but it let timeline cards underneath bleed through and
     collide with the elapsed counter. The header is a fixed surface; treat
     it like one. The shadow underneath provides the elevation cue instead. */
  background-color: var(--ink-1);
  background-image:
    linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--accent) 1.5%, transparent) 50%, transparent 100%),
    repeating-linear-gradient(
      0deg,
      transparent 0px, transparent 3px,
      color-mix(in srgb, var(--paper-0) 1.2%, transparent) 3px, color-mix(in srgb, var(--paper-0) 1.2%, transparent) 4px
    );
  border-bottom: 1px solid var(--ink-line-strong);
  box-shadow: 0 6px 18px -8px color-mix(in srgb, var(--ink-0) 50%, transparent);
  padding: 0.9rem 1.5rem 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.run-header[data-status="running"]::before {
  /* Active runs get a thin amber rule along the bottom — the "live wire". */
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: -1px;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent) 40%,
    var(--accent) 60%,
    transparent 100%
  );
  animation: wire-pulse 2.4s ease-in-out infinite;
}
@keyframes wire-pulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}

.run-header__row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: baseline;
  gap: 1.5rem;
}
.run-header__lead {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  min-width: 0;
}
.run-header__status {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  color: var(--paper-3);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.run-header[data-status="running"] .run-header__status { color: var(--accent); }
.run-header[data-status="complete"] .run-header__status { color: var(--tape-up); }
.run-header[data-status="failed"] .run-header__status,
.run-header[data-status="cancelled"] .run-header__status { color: var(--tape-down); }

.run-header__beacon {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 var(--accent);
  animation: beacon 1.4s ease-out infinite;
}
@keyframes beacon {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
  70%  { box-shadow: 0 0 0 7px color-mix(in srgb, var(--accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
}

.run-header__symbol {
  font-family: var(--font-mono);
  font-size: 1.1rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--paper-0);
  text-transform: uppercase;
}

.run-header__elapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  min-width: 6.5rem;
}
.run-header__elapsed-value {
  font-size: 1.65rem;
  line-height: 1;
  font-weight: 400;
  letter-spacing: 0.02em;
  color: var(--paper-0);
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "ss01" 1;
}
.run-header__elapsed-unit {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--paper-3);
}

.run-header__actions {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 1rem;
}
.run-header__events {
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  color: var(--paper-3);
  text-transform: uppercase;
  font-variant-numeric: tabular-nums;
}
.run-header__cancel {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-2);
  background: transparent;
  border: 1px solid var(--ink-line-strong);
  padding: 0.4rem 0.85rem;
  border-radius: 3px;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease, background-color 160ms ease;
}
.run-header__cancel:hover {
  color: var(--tape-down);
  border-color: var(--tape-down);
}
.run-header__cancel[data-urgent="true"] {
  color: var(--tape-down);
  border-color: var(--tape-down);
  animation: urgent-flash 1.2s ease-in-out infinite;
}
@keyframes urgent-flash {
  0%, 100% { background: transparent; }
  50% { background: color-mix(in srgb, var(--tape-down) 8%, transparent); }
}

.run-header__activity {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-1);
  flex-wrap: wrap;
  min-height: 1.2rem;
}
.run-header__activity[data-quiet="true"] { color: var(--paper-3); }
.run-header__activity-node {
  text-transform: lowercase;
  letter-spacing: 0.04em;
  color: var(--paper-0);
  font-weight: 500;
}
.run-header[data-status="running"] .run-header__activity-node { color: var(--accent); }
.run-header__activity-icon { width: 0.8rem; height: 0.8rem; color: var(--paper-3); flex-shrink: 0; }
.run-header__activity-glyph {
  color: var(--paper-3);
  font-size: 0.85rem;
}
.run-header__activity-tool {
  color: var(--paper-2);
  font-size: 0.78rem;
}
.run-header__since {
  margin-left: auto;
  font-size: 0.7rem;
  color: var(--paper-3);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}
.run-header__since[data-stuck="soft"] { color: var(--accent); }
.run-header__since[data-stuck="hard"] { color: var(--tape-down); font-weight: 500; }

.run-header__stuck {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--paper-2);
  padding: 0.5rem 0.7rem;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  background: color-mix(in srgb, var(--accent) 4%, transparent);
  border-radius: var(--radius-sm);
}
.run-header__stuck[data-level="hard"] {
  color: var(--paper-1);
  border-color: color-mix(in srgb, var(--tape-down) 35%, transparent);
  background: color-mix(in srgb, var(--tape-down) 6%, transparent);
}

@media (max-width: 720px) {
  .run-header__row { grid-template-columns: 1fr; gap: 0.6rem; }
  .run-header__elapsed { align-items: flex-start; }
  .run-header__actions { justify-content: flex-start; }
}
</style>
