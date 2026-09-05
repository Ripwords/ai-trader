<script setup lang="ts">
import { activeSectionKey } from '~/lib/sections'

interface Props {
  drawerOpen?: boolean
}

const props = withDefaults(defineProps<Props>(), { drawerOpen: false })
const emit = defineEmits<{ 'toggle-drawer': []; 'sign-out': [] }>()

const route = useRoute()
const llmModel = useRuntimeConfig().public.llmModel || 'unset'
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

// The status strip reflects the real OpenD state instead of a static
// green dot: down, quote-only, or live. Polled once a minute.
interface OpendStatus { reachable: boolean; qot_logined: boolean; trd_logined: boolean }
const opend = ref<OpendStatus | null>(null)
let opendTimer: ReturnType<typeof setInterval> | null = null
async function refreshOpend(): Promise<void> {
  try {
    opend.value = await $fetch<OpendStatus>('/api/opend-status')
  } catch {
    opend.value = { reachable: false, qot_logined: false, trd_logined: false }
  }
}
const opendLabel = computed(() => {
  if (opend.value === null) return 'opend · checking'
  if (!opend.value.reachable) return 'opend · down'
  if (!opend.value.qot_logined) return 'opend · no quotes'
  return 'live · paper'
})
const opendTone = computed(() => {
  if (opend.value === null) return 'pending'
  if (!opend.value.reachable || !opend.value.qot_logined) return 'down'
  return 'up'
})

onMounted(() => {
  clock.value = new Date()
  timer = setInterval(() => { clock.value = new Date() }, 1000)
  void refreshOpend()
  opendTimer = setInterval(() => { void refreshOpend() }, 60_000)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (opendTimer) clearInterval(opendTimer)
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
    </div>

    <div class="middle">
      <SectionNav variant="inline" />
    </div>

    <div class="right">
      <div class="status-strip" data-mono :title="opendLabel">
        <span class="status-dot" :data-tone="opendTone" />
        <span>{{ opendLabel }}</span>
      </div>
      <div class="clock" data-mono>{{ clockText }}</div>
      <button class="signout" aria-label="Sign out" title="Sign out" @click="logout">
        <UIcon name="i-lucide-log-out" class="signout-icon" />
        <span class="signout-text">sign out</span>
      </button>
    </div>

    <div class="model-tag" data-mono>
      <span class="model-tag-label">model</span>
      <span class="model-tag-sep">·</span>
      <span class="model-tag-value">{{ llmModel }}</span>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  height: 56px;
  padding: 0 1.25rem;
  border-bottom: 1px solid var(--hairline, rgba(255,255,255,0.06));
  background: var(--ink-0);
  flex-shrink: 0;
  z-index: 30;
}

@media (min-width: 1024px) {
  .app-header { height: 64px; padding: 0 1.75rem; }
}

/* ---------------- left: hamburger + brand ---------------- */
.left { display: flex; align-items: center; gap: 0.85rem; min-width: 0; }

.hamburger {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  width: 36px;
  height: 36px;
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
}
.brand-mark {
  font-family: var(--font-display, ui-serif, Georgia, serif);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--paper-3);
}
.brand-mark > :first-child { color: var(--accent); }
.brand-trader { color: var(--paper-0); }

.brand-section {
  display: none;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding-left: 0.85rem;
  border-left: 1px solid var(--hairline, rgba(255,255,255,0.08));
}
@media (min-width: 640px) {
  .brand-section { display: inline; }
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

.status-strip {
  display: none;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding-right: 1rem;
  border-right: 1px solid var(--hairline, rgba(255,255,255,0.08));
}
@media (min-width: 1280px) {
  .status-strip { display: flex; }
}
.status-dot {
  width: 6px; height: 6px;
  border-radius: 999px;
  background: #5fbf73;
  box-shadow: 0 0 8px rgba(95, 191, 115, 0.55);
  animation: pulse 2.4s ease-in-out infinite;
}
.status-dot[data-tone="down"] {
  background: var(--tape-down);
  box-shadow: 0 0 8px color-mix(in srgb, var(--tape-down) 55%, transparent);
  animation: none;
}
.status-dot[data-tone="pending"] {
  background: var(--paper-3);
  box-shadow: none;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
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
  gap: 0.5rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  padding: 0.4rem 0.55rem;
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
  font-size: 0.55rem;
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
