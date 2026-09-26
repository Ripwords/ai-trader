<script setup lang="ts">
defineProps<{ rows: { label: string; value: string }[] }>()
</script>

<template>
  <details v-if="rows.length > 0" class="tech" data-testid="technical-details">
    <summary class="tech__summary">Technical details</summary>
    <dl class="tech__list">
      <template v-for="row in rows" :key="row.label">
        <dt class="tech__label">{{ row.label }}</dt>
        <dd class="tech__value" data-mono>{{ row.value }}</dd>
      </template>
    </dl>
  </details>
</template>

<style scoped>
.tech {
  font-size: 0.72rem;
  color: var(--paper-3);
}
.tech__summary {
  cursor: pointer;
  width: fit-content;
  letter-spacing: 0.04em;
}
.tech__summary:hover {
  color: var(--paper-2);
}
.tech__list {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 0.25rem 0.75rem;
  margin-top: 0.5rem;
}
.tech__label {
  color: var(--paper-3);
}
.tech__value {
  color: var(--paper-2);
  overflow-wrap: anywhere;
  user-select: all;
}
</style>
