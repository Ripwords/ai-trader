<script setup lang="ts">
import { SECTIONS, activeSectionKey, type Section } from '~/lib/sections'

interface Props {
  // 'inline' = horizontal row in desktop header.
  // 'stack'  = vertical big-tap rows in mobile drawer.
  variant?: 'inline' | 'stack'
}

const props = withDefaults(defineProps<Props>(), { variant: 'inline' })
const emit = defineEmits<{ navigate: [Section] }>()

const route = useRoute()
const active = computed(() => activeSectionKey(route.path))

function isActive(s: Section): boolean {
  return active.value === s.key
}
</script>

<template>
  <nav v-if="props.variant === 'inline'" class="flex items-center gap-1">
    <NuxtLink
      v-for="s in SECTIONS"
      :key="s.key"
      :to="s.to"
      class="section-link"
      :class="{ 'is-active': isActive(s) }"
      @click="emit('navigate', s)"
    >
      <span class="label">{{ s.label }}</span>
      <span class="rail" aria-hidden="true" />
    </NuxtLink>
  </nav>

  <nav v-else class="flex flex-col">
    <NuxtLink
      v-for="(s, i) in SECTIONS"
      :key="s.key"
      :to="s.to"
      class="stack-row"
      :class="{ 'is-active': isActive(s) }"
      @click="emit('navigate', s)"
    >
      <span class="stack-index">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="stack-body">
        <span class="stack-label">{{ s.label }}</span>
        <span class="stack-blurb">{{ s.blurb }}</span>
      </span>
      <span class="stack-marker" aria-hidden="true">→</span>
    </NuxtLink>
  </nav>
</template>

<style scoped>
/* --- Inline (desktop) ---------------------------------------------------- */
.section-link {
  position: relative;
  padding: 0.4rem 0.85rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  transition: color 180ms ease;
}
.section-link:hover { color: var(--paper-0); }
.section-link.is-active { color: var(--accent); }

.section-link .rail {
  position: absolute;
  left: 0.85rem;
  right: 0.85rem;
  bottom: -1px;
  height: 1px;
  background: var(--accent);
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 220ms cubic-bezier(0.6, 0, 0.2, 1);
}
.section-link.is-active .rail { transform: scaleX(1); }
.section-link:hover .rail { transform: scaleX(0.4); }
.section-link.is-active:hover .rail { transform: scaleX(1); }

/* --- Stack (mobile drawer) ----------------------------------------------- */
.stack-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 1.25rem;
  align-items: center;
  padding: 1.05rem 1.5rem;
  border-bottom: 1px solid var(--hairline, rgba(255,255,255,0.06));
  text-decoration: none;
  position: relative;
  transition: background-color 160ms ease;
}
.stack-row:hover { background: var(--ink-2); }
.stack-row.is-active { background: var(--ink-2); }
.stack-row.is-active::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--accent);
}

.stack-index {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
  font-variant-numeric: tabular-nums;
}
.stack-row.is-active .stack-index { color: var(--accent); }

.stack-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.stack-label {
  font-size: 1.1rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--paper-0);
}
.stack-blurb {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.7rem;
  letter-spacing: 0.05em;
  color: var(--paper-3);
}
.stack-marker {
  color: var(--paper-3);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.95rem;
  transition: transform 180ms ease, color 180ms ease;
}
.stack-row:hover .stack-marker { transform: translateX(4px); color: var(--accent); }
.stack-row.is-active .stack-marker { color: var(--accent); }
</style>
