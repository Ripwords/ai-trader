<!-- Hallmark · component: shell · genre: modern-minimal · design-system: design.md -->
<script setup lang="ts">
import { activeSectionKey } from '~/lib/sections'
import { useOpendStatus } from '~/composables/useOpendStatus'
import { opendIndicator } from '~/utils/opend-indicator'
import type { LlmSettings } from '../../../types/llm'

interface Props {
  drawerOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), { drawerOpen: false })
const emit = defineEmits<{ 'toggle-drawer': []; 'sign-out': [] }>()

const route = useRoute()
const { data: llmSelection } = useFetch<{ selection: LlmSettings | null }>('/api/settings/llm/selection', { key: 'llm-selection' })
const llmModel = computed(() => llmSelection.value?.selection?.chat.modelId ?? 'not set')
// Live clock: ``new Date()`` at SSR time always lags the browser's clock
// by hundreds of ms by the time hydration runs, which produces a Vue
// hydration mismatch on every page load. The mismatch warning isn't just
// noise — Vue gives up on the surrounding subtree and re-renders it
// client-side, which is what was breaking the global layout.
//
// Fix: render an empty clock during SSR / pre-mount (server emits the
// same empty string as the client's first paint), then start ticking
// after onMounted. The clock visibly "appears" within one frame, which
// is fine — the alternative is a global layout re-hydration.
const clock = ref<Date | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const { status: opend } = useOpendStatus()
const broker = computed(() => opendIndicator(opend.value))

onMounted(() => {
  clock.value = new Date()
  timer = setInterval(() => { clock.value = new Date() }, 1000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
const clockText = computed(() => {
  if (clock.value === null) return '--:--:--'
  return clock.value.toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
})

const activeKey = computed(() => activeSectionKey(route.path))

async function logout(): Promise<void> {
  emit('sign-out')
  await $fetch('/api/logout', { method: 'POST' }).catch(() => {})
  await navigateTo('/login')
}
</script>

<template>
  <header class="app-header">
    <div class="left">
      <button
        class="hamburger"
        :aria-expanded="props.drawerOpen"
        aria-label="Toggle navigation"
        @click="emit('toggle-drawer')"
      >
        <span :class="['bar', { 'is-x-1': props.drawerOpen }]" />
        <span :class="['bar', { 'is-x-2': props.drawerOpen }]" />
        <span :class="['bar', { 'is-x-3': props.drawerOpen }]" />
      </button>

      <NuxtLink to="/" class="brand">
        <span class="brand-mark"><span>ai</span><span class="brand-trader">·trader</span></span>
        <span class="brand-section">{{ activeKey }}</span>
      </NuxtLink>
      <span class="brand-status" :title="broker.label">
        <span class="brand-status-dot" :data-tone="broker.tone" aria-hidden="true" />
        <span class="sr-only">{{ broker.label }}</span>
      </span>
    </div>

    <div class="middle">
      <SectionNav variant="inline" />
    </div>

    <div class="right">
      <StatusPill class="status-strip" :tone="broker.tone" :label="broker.label" />
      <div class="clock" data-mono>{{ clockText }}</div>
      <button class="signout" aria-label="Sign out" title="Sign out" @click="logout">
        <UIcon name="i-lucide-log-out" class="signout-icon" />
        <span class="signout-text">sign out</span>
      </button>
    </div>

    <NuxtLink to="/settings" class="model-tag" data-mono title="Change model in Settings">
      <span class="model-tag-label">model</span>
      <span class="model-tag-sep">·</span>
      <span class="model-tag-value">{{ llmModel }}</span>
    </NuxtLink>
  </header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  height: calc(56px + env(safe-area-inset-top));
  padding: env(safe-area-inset-top) var(--page-x) 0;
  border-bottom: 1px solid var(--ink-line);
  background: var(--ink-0);
  flex-shrink: 0;
  z-index: 30;
}

@media (min-width: 1024px) {
  .app-header { height: calc(64px + env(safe-area-inset-top)); }
}

/* ---------------- left: hamburger + brand ---------------- */
.left { display: flex; align-items: center; gap: 0.85rem; min-width: 0; }

.hamburger {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  width: 44px;
  height: 44px;
  margin-left: -0.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: background-color 160ms ease;
  flex-shrink: 0;
}
.hamburger:hover { background: var(--ink-2); }
.hamburger .bar {
  display: block;
  width: 18px;
  height: 1px;
  background: var(--paper-2);
  transition: transform 220ms cubic-bezier(0.6, 0, 0.2, 1), opacity 160ms ease;
  transform-origin: center;
}
.hamburger .bar.is-x-1 { transform: translateY(5px) rotate(45deg); background: var(--accent); }
.hamburger .bar.is-x-2 { opacity: 0; transform: scaleX(0); }
.hamburger .bar.is-x-3 { transform: translateY(-5px) rotate(-45deg); background: var(--accent); }

@media (min-width: 1024px) {
  .hamburger { display: none; }
}

.brand {
  display: inline-flex;
  align-items: baseline;
  gap: 0.85rem;
  text-decoration: none;
  min-width: 0;
  min-height: 44px;
  align-content: center;
  flex-wrap: wrap;
}
.brand-mark {
  font-family: var(--font-sans);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--paper-3);
}
.brand-mark > :first-child { color: var(--accent); }
.brand-trader { color: var(--paper-0); }

.brand-section {
  display: none;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding-left: 0.85rem;
  border-left: 1px solid var(--ink-line);
}
@media (min-width: 640px) {
  .brand-section { display: inline; }
}

/* Compact broker readout for every width the full status strip is hidden at. */
.brand-status {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.brand-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--paper-3);
}
.brand-status-dot[data-tone="up"] { background: var(--tape-up); }
.brand-status-dot[data-tone="down"] { background: var(--tape-down); }
@media (min-width: 1280px) {
  .brand-status { display: none; }
}

/* ---------------- middle: section nav --------------------- */
.middle {
  display: none;
  justify-content: center;
  min-width: 0;
}
@media (min-width: 1024px) {
  .middle { display: flex; }
}

/* ---------------- right: status / clock / signout -------- */
.right { display: flex; align-items: center; gap: 1rem; }

.right .status-strip {
  display: none;
  padding-right: 1rem;
  border-right: 1px solid var(--ink-line);
}
@media (min-width: 1280px) {
  .right .status-strip { display: inline-flex; }
}

.clock {
  display: none;
  font-size: 0.85rem;
  letter-spacing: 0.05em;
  color: var(--paper-2);
  font-variant-numeric: tabular-nums;
}
@media (min-width: 768px) {
  .clock { display: inline; }
}

.signout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding: 0.4rem 0.55rem;
  min-height: 44px;
  min-width: 44px;
  margin-right: -0.55rem;
  border-radius: 6px;
  transition: color 160ms ease, background-color 160ms ease;
}
.signout:hover { color: var(--accent); background: var(--ink-2); }
.signout-icon { width: 16px; height: 16px; flex-shrink: 0; }
.signout-text { display: none; }
@media (min-width: 768px) {
  .signout-text { display: inline; }
}

/* ---------------- bottom strip: model tag ---------------- */
.model-tag {
  position: absolute;
  bottom: -1px;
  right: 1.75rem;
  height: 1px;
  display: none;
  align-items: center;
  gap: 0.5rem;
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding: 0 0.6rem;
  background: var(--ink-0);
  transform: translateY(50%);
}
.model-tag-label { color: var(--paper-3); }
.model-tag-value { color: var(--accent); }
.model-tag-sep { color: var(--paper-3); opacity: 0.5; }

@media (min-width: 1024px) {
  .model-tag { display: flex; }
}
</style>
