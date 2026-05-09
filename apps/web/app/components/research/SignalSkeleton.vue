<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  source: string
  running: boolean
}>()

const label = computed(() => props.source.toUpperCase())
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden skel-card" :class="{ 'is-running': props.running, 'is-queued': !props.running }">
    <header class="px-5 py-3 border-b hairline flex items-baseline justify-between gap-3">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] truncate">
        {{ label }}
      </div>
      <div
        class="font-mono text-xs uppercase tracking-[0.18em] flex items-baseline gap-1"
        :class="props.running ? 'text-[var(--accent)]' : 'text-[var(--paper-3)] opacity-60'"
      >
        <span v-if="props.running" class="cursor" aria-hidden="true">▮</span>
        <span>{{ props.running ? 'streaming' : 'queued' }}</span>
      </div>
    </header>

    <div class="px-5 py-4 space-y-3">
      <div class="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-[var(--paper-3)] flex items-baseline gap-2">
        <span class="text-[var(--accent)]">›</span>
        <span>analyzing<span class="dots"><span>.</span><span>.</span><span>.</span></span></span>
      </div>
      <div class="space-y-2 pt-1">
        <div class="skel-line" style="width: 78%; --d: 0ms" />
        <div class="skel-line" style="width: 64%; --d: 220ms" />
        <div class="skel-line" style="width: 88%; --d: 440ms" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.skel-card {
  position: relative;
  transition: opacity 220ms ease;
}
.skel-card.is-queued { opacity: 0.45; }

/* Subtle hairline scan that crosses the card edge while running */
.skel-card.is-running::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(
    115deg,
    transparent 0%,
    transparent 42%,
    color-mix(in srgb, var(--accent) 9%, transparent) 50%,
    transparent 58%,
    transparent 100%
  );
  background-size: 220% 100%;
  animation: scan 2.6s ease-in-out infinite;
  mix-blend-mode: screen;
}
@keyframes scan {
  0% { background-position: 220% 0; }
  100% { background-position: -120% 0; }
}

.cursor {
  display: inline-block;
  animation: blink 1s steps(2, end) infinite;
}
@keyframes blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}

.dots {
  display: inline-flex;
  margin-left: 1px;
  letter-spacing: 0.04em;
}
.dots span {
  opacity: 0.25;
  animation: dot-pulse 1.4s ease-in-out infinite;
}
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-pulse {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

.skel-line {
  height: 0.55rem;
  border-radius: 1px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--paper-3) 6%, transparent) 0%,
    color-mix(in srgb, var(--paper-3) 18%, transparent) 50%,
    color-mix(in srgb, var(--paper-3) 6%, transparent) 100%
  );
  background-size: 200% 100%;
  animation: shimmer 1.8s ease-in-out infinite;
  animation-delay: var(--d, 0ms);
}
.skel-card.is-queued .skel-line {
  animation: none;
  background: color-mix(in srgb, var(--paper-3) 8%, transparent);
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
