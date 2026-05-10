<script setup lang="ts">
defineProps<{ round: number; bull: string; bear: string }>()
</script>

<template>
  <section class="debate surface-1" data-testid="debate-round">
    <header class="head">
      <span class="eyebrow">debate · round {{ round }}</span>
    </header>
    <div class="cols">
      <article class="col" data-side="bull">
        <div class="side-label">bull</div>
        <p class="text">{{ bull || '—' }}</p>
      </article>
      <article class="col" data-side="bear">
        <div class="side-label">bear</div>
        <p class="text">{{ bear || '—' }}</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.debate {
  border-radius: 6px;
  padding: 0.9rem 1.1rem 1.05rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.7rem;
}
@media (min-width: 640px) {
  .cols { grid-template-columns: 1fr 1fr; }
}
.col {
  border: 1px solid var(--ink-line);
  border-radius: 4px;
  padding: 0.7rem 0.85rem;
  background: var(--ink-2);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.col[data-side="bull"] { border-left: 2px solid var(--tape-up); }
.col[data-side="bear"] { border-left: 2px solid var(--tape-down); }

.side-label {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.col[data-side="bull"] .side-label { color: var(--tape-up); }
.col[data-side="bear"] .side-label { color: var(--tape-down); }

.text {
  margin: 0;
  font-size: 0.85rem;
  color: var(--paper-1);
  line-height: 1.55;
  white-space: pre-wrap;
}
</style>
