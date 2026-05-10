<script setup lang="ts">
defineProps<{ catalysts: string[], risks: string[] }>()
</script>

<template>
  <section class="cr">
    <div class="col surface-1" data-side="up">
      <header>
        <span class="arrow">↗</span>
        <span class="eyebrow">catalysts</span>
        <span class="count" data-mono>{{ catalysts.length }}</span>
      </header>
      <ul>
        <li v-for="(c, i) in catalysts" :key="i">{{ c }}</li>
        <li v-if="catalysts.length === 0" class="empty">no catalysts surfaced</li>
      </ul>
    </div>
    <div class="col surface-1" data-side="down">
      <header>
        <span class="arrow">↘</span>
        <span class="eyebrow">risks</span>
        <span class="count" data-mono>{{ risks.length }}</span>
      </header>
      <ul>
        <li v-for="(r, i) in risks" :key="i">{{ r }}</li>
        <li v-if="risks.length === 0" class="empty">no risks surfaced</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.cr {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}
@media (min-width: 768px) {
  .cr { grid-template-columns: 1fr 1fr; }
}
.col {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  padding: 1.1rem 1.2rem 1.2rem;
  border-radius: 6px;
  position: relative;
}
.col::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  border-radius: 6px 0 0 6px;
}
.col[data-side="up"]::before   { background: color-mix(in srgb, var(--tape-up) 70%, transparent); }
.col[data-side="down"]::before { background: color-mix(in srgb, var(--tape-down) 70%, transparent); }

header {
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
}
.arrow {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  line-height: 1;
}
.col[data-side="up"]   .arrow { color: var(--tape-up); }
.col[data-side="down"] .arrow { color: var(--tape-down); }

.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-2);
  flex: 1;
}
.count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--paper-3);
  letter-spacing: 0.18em;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
li {
  font-family: var(--font-sans);
  font-size: 0.88rem;
  line-height: 1.5;
  color: var(--paper-1);
  padding-left: 1rem;
  position: relative;
}
li::before {
  content: '·';
  position: absolute;
  left: 0;
  color: var(--paper-3);
  font-weight: 700;
}
.empty {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-3);
  letter-spacing: 0.04em;
}
.empty::before { content: ''; }
</style>
