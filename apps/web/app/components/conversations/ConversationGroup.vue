<script setup lang="ts">
interface Item { id: string; title: string; updatedAt: string }
const props = defineProps<{ label: string; items: Item[]; activeId?: string | null }>()
defineEmits<{ select: [id: string]; remove: [id: string] }>()
</script>

<template>
  <div v-if="props.items.length > 0" class="py-2">
    <div class="px-5 pb-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-[var(--paper-3)]">
      {{ props.label }}
    </div>
    <ul>
      <li
        v-for="i in props.items"
        :key="i.id"
        class="group px-5 py-2 hover:bg-[var(--ink-2)] cursor-pointer flex items-center justify-between gap-2 transition-colors border-l-2 text-sm"
        :class="i.id === props.activeId
          ? 'border-[var(--accent)] bg-[var(--ink-2)]'
          : 'border-transparent hover:border-[var(--accent)]'"
        @click="$emit('select', i.id)"
      >
        <span class="truncate text-[var(--paper-0)]">{{ i.title }}</span>
        <button
          class="opacity-0 group-hover:opacity-100 font-mono text-base text-[var(--paper-3)] hover:text-[var(--tape-down)] transition leading-none"
          title="Delete"
          @click.stop="$emit('remove', i.id)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>
