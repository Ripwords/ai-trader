<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })

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
    <Transition name="drawer">
      <aside
        v-if="open"
        class="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Application navigation"
      >
        <div class="drawer-header">
          <div class="font-mono text-xs uppercase tracking-[0.22em] text-[var(--paper-3)]">menu</div>
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
          <span class="font-mono text-[0.6rem] uppercase tracking-[0.22em] text-[var(--paper-3)]">ai-trader · v0.1</span>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
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
  background: var(--ink-0);
  border-right: 1px solid var(--hairline, rgba(255,255,255,0.08));
  z-index: 90;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  box-shadow: 24px 0 60px rgba(0, 0, 0, 0.6);
}
.drawer-enter-active, .drawer-leave-active {
  transition: transform 280ms cubic-bezier(0.6, 0, 0.2, 1);
}
.drawer-enter-from, .drawer-leave-to {
  transform: translateX(-100%);
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--hairline, rgba(255,255,255,0.06));
  flex-shrink: 0;
}

.close {
  position: relative;
  width: 36px; height: 36px;
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
  border-top: 1px solid var(--hairline, rgba(255,255,255,0.06));
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.drawer-foot {
  border-top: 1px solid var(--hairline, rgba(255,255,255,0.06));
  padding: 0.85rem 1.5rem;
  flex-shrink: 0;
}
</style>
