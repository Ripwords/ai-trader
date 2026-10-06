<!-- Hallmark · component: shell · genre: modern-minimal · design-system: design.md -->
<script setup lang="ts">
import { useOpendStatus } from '~/composables/useOpendStatus'
import { opendIndicator } from '~/utils/opend-indicator'
import type { LlmSettings } from '../../../types/llm'

const open = defineModel<boolean>('open', { default: false })

// Phones never see the header's status strip or model tag, so the drawer
// carries both. Same fetch key as the header and settings page: one request.
const { status: opend } = useOpendStatus()
const broker = computed(() => opendIndicator(opend.value))
const { data: llmSelection } = useFetch<{ selection: LlmSettings | null }>('/api/settings/llm/selection', { key: 'llm-selection' })
const llmModel = computed(() => llmSelection.value?.selection?.chat.modelId ?? 'not set')

const route = useRoute()
// Auto-close on navigation so the drawer doesn't linger after a tap.
watch(() => route.fullPath, () => { open.value = false })

// Lock body scroll while open — the drawer owns the viewport on mobile.
watchEffect(() => {
  if (typeof document === 'undefined') return
  document.body.style.overflow = open.value ? 'hidden' : ''
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.body.style.overflow = ''
})

// Escape closes.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => { window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey) })
</script>

<template>
  <Teleport to="body">
    <Transition name="scrim">
      <div
        v-if="open"
        class="scrim"
        @click="open = false"
      />
    </Transition>
    <!-- Stays mounted and slides on a transform rather than v-if. Pages
         teleport into #shell-drawer-extra below, and a teleport target that
         blinks in and out of existence cannot be a stable destination. -->
    <aside
      class="drawer"
      :class="{ 'is-open': open }"
      role="dialog"
      aria-modal="true"
      aria-label="Application navigation"
      :aria-hidden="!open"
      :inert="!open"
    >
      <div class="drawer-header">
        <div class="label-eyebrow">menu</div>
        <button
          class="close"
          aria-label="Close menu"
          @click="open = false"
        >
          <span class="bar bar-1" />
          <span class="bar bar-2" />
        </button>
      </div>

      <SectionNav variant="stack" />

      <div v-if="$slots.extra" class="drawer-extra">
        <slot name="extra" />
      </div>

      <div class="drawer-foot">
        <StatusPill :tone="broker.tone" :label="broker.label" />
        <NuxtLink to="/settings" class="foot-model tap">
          <span class="label-eyebrow">model</span>
          <span class="foot-model-value">{{ llmModel }}</span>
        </NuxtLink>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--ink-0) 60%, transparent);
  backdrop-filter: blur(4px);
  z-index: 80;
}
.scrim-enter-active, .scrim-leave-active {
  transition: opacity 240ms ease;
}
.scrim-enter-from, .scrim-leave-to { opacity: 0; }

.drawer {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: min(360px, 88vw);
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  background: var(--ink-0);
  border-right: 1px solid var(--ink-line);
  z-index: 90;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-shadow: 24px 0 60px color-mix(in srgb, var(--ink-0) 60%, transparent);
  transform: translateX(-100%);
  visibility: hidden;
  transition: transform 280ms cubic-bezier(0.6, 0, 0.2, 1), visibility 0s linear 280ms;
}
.drawer.is-open {
  transform: translateX(0);
  visibility: visible;
  transition: transform 280ms cubic-bezier(0.6, 0, 0.2, 1), visibility 0s;
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--ink-line);
  flex-shrink: 0;
}

.close {
  position: relative;
  width: 44px; height: 44px;
  margin-right: -0.55rem;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background-color 160ms ease;
}
.close:hover { background: var(--ink-2); }
.close .bar {
  position: absolute;
  width: 18px; height: 1px;
  background: var(--paper-0);
}
.close .bar-1 { transform: rotate(45deg); }
.close .bar-2 { transform: rotate(-45deg); }

.drawer-extra {
  border-top: 1px solid var(--ink-line);
  flex: none;
  display: flex;
  flex-direction: column;
}

/* Pages teleport a rail in here that was authored as a full-height desktop
   column. The drawer shares its column with the section nav, so there is no
   leftover height to fill: stretching the rail into it collapsed the watchlist
   to zero and stacked it underneath the conversation list. Size to content and
   let the drawer scroll, capping the watchlist so a long tape cannot push the
   chat history off the end. */
.drawer-extra :deep(.rail-body) { height: auto; }
.drawer-extra :deep(.rail-body) > * { flex: none; }
.drawer-extra :deep(.rail-body) > :first-child { max-height: 50vh; }
/* The layout always renders the #shell-drawer-extra teleport target, so the
   slot is never empty — only pages that actually teleport into it should get
   the divider and the flex-grow. */
.drawer-extra:not(:has(#shell-drawer-extra > *)) { display: none; }

.drawer-foot {
  border-top: 1px solid var(--ink-line);
  padding: 0.5rem 1.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-shrink: 0;
  /* Nothing above it stretches any more, so this is what holds it to the
     bottom on pages that teleport nothing into the drawer. */
  margin-top: auto;
}
.foot-model {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  min-height: 44px;
  margin-right: -0.5rem;
  padding: 0 0.5rem;
  border-radius: var(--radius-sm);
  text-decoration: none;
  transition: background-color 160ms ease;
}
.foot-model:hover { background: var(--ink-2); }
.foot-model-value {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
