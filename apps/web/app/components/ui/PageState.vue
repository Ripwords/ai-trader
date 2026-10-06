<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  kind: 'loading' | 'empty' | 'error'
  message: string
  /** Declared so a bound `@retry` is visible here; the button renders only then. */
  onRetry?: () => void
}>()
const emit = defineEmits<{ retry: [] }>()

const role = computed(() => (props.kind === 'error' ? 'alert' : props.kind === 'loading' ? 'status' : undefined))
</script>

<template>
  <div class="page-state" :class="`page-state--${kind}`" :role="role">
    <span>{{ message }}</span>
    <button v-if="kind === 'error' && onRetry" type="button" class="page-state__retry tap" @click="emit('retry')">
      retry
    </button>
  </div>
</template>

<style scoped>
.page-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 1rem 0;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--paper-3);
  overflow-wrap: anywhere;
}
.page-state--error { color: var(--tape-down); }
.page-state__retry {
  padding: 0.25rem 0.625rem;
  border: 1px solid var(--ink-line-strong);
  border-radius: var(--radius-sm);
  color: var(--paper-1);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.page-state__retry:hover { border-color: var(--accent); color: var(--accent); }
</style>
