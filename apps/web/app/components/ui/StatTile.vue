<script setup lang="ts">
import type { Tone } from '../../utils/portfolio-view'

withDefaults(defineProps<{
  label: string
  value: string
  sub?: string
  tone?: Tone
  size?: 'md' | 'lg'
}>(), { sub: '', tone: 'neutral', size: 'md' })

const TONE_CLASS: Record<Tone, string> = {
  up: 'tape-up',
  down: 'tape-down',
  accent: 'text-[var(--accent)]',
  neutral: 'text-[var(--paper-0)]',
}
</script>

<template>
  <div class="stat-tile">
    <div class="stat-tile__label label-eyebrow">{{ label }}</div>
    <div
      class="stat-tile__value font-mono"
      :class="[TONE_CLASS[tone], size === 'lg' ? 'stat-value-lg' : 'stat-value']"
      data-mono
    >{{ value }}</div>
    <div v-if="sub" class="stat-tile__sub">{{ sub }}</div>
  </div>
</template>

<style scoped>
.stat-tile {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
}
.stat-tile__sub {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  color: var(--paper-3);
}
</style>
