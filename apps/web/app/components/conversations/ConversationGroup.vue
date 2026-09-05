<script setup lang="ts">
interface Item {
  id: string
  title: string
  updatedAt: string
  pinned?: boolean
  archived?: boolean
  summary?: string
  decision_count?: number
  match?: { source: string; snippet: string }
}
const props = defineProps<{ label: string; items: Item[]; activeId?: string | null }>()
defineEmits<{
  select: [id: string]
  pin: [id: string, pinned: boolean]
  archive: [id: string, archived: boolean]
  remove: [id: string]
}>()
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
        class="group px-5 py-2 hover:bg-[var(--ink-2)] focus-within:bg-[var(--ink-2)] cursor-pointer flex items-start justify-between gap-2 transition-colors border-l-2 text-sm outline-none"
        :class="i.id === props.activeId
          ? 'border-[var(--accent)] bg-[var(--ink-2)]'
          : 'border-transparent hover:border-[var(--accent)] focus-visible:border-[var(--accent)]'"
        role="button"
        tabindex="0"
        :aria-current="i.id === props.activeId ? 'true' : undefined"
        @click="$emit('select', i.id)"
        @keydown.enter.prevent="$emit('select', i.id)"
        @keydown.space.prevent="$emit('select', i.id)"
      >
        <span class="min-w-0">
          <span class="block truncate text-[var(--paper-0)]">
            {{ i.pinned ? 'pin · ' : '' }}{{ i.title }}
          </span>
          <span
            v-if="i.match?.snippet || i.summary || i.decision_count"
            class="block mt-1 font-mono text-[10px] text-[var(--paper-3)] truncate"
          >
            {{ i.match?.snippet || i.summary || `${i.decision_count} decision${i.decision_count === 1 ? '' : 's'}` }}
          </span>
        </span>
        <span class="shrink-0 flex items-center gap-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition">
          <button
            class="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--paper-3)] hover:text-[var(--accent)]"
            :title="i.pinned ? 'Unpin' : 'Pin'"
            @click.stop="$emit('pin', i.id, !i.pinned)"
          >
            {{ i.pinned ? 'unpin' : 'pin' }}
          </button>
          <button
            class="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--paper-3)] hover:text-[var(--accent)]"
            :title="i.archived ? 'Restore' : 'Archive'"
            @click.stop="$emit('archive', i.id, !i.archived)"
          >
            {{ i.archived ? 'restore' : 'hide' }}
          </button>
          <button
            class="font-mono text-base text-[var(--paper-3)] hover:text-[var(--tape-down)] leading-none"
            title="Delete"
            @click.stop="$emit('remove', i.id)"
          >
            ×
          </button>
        </span>
      </li>
    </ul>
  </div>
</template>
