<script setup lang="ts">
interface NewsItem { title: string; url: string; content: string; published_date?: string }
const props = defineProps<{ results: NewsItem[] }>()

function host(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' }
}
function fmtDate(d?: string): string {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return d }
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">News tape</div>
      <div class="font-mono text-xs text-[var(--paper-3)]">{{ props.results.length }} items</div>
    </header>
    <ul class="divide-y hairline">
      <li v-for="(r, i) in props.results" :key="i" class="px-5 py-4 hover:bg-[var(--ink-2)] transition-colors">
        <div class="flex items-baseline gap-3 mb-2">
          <span class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-3)]">{{ host(r.url) || '—' }}</span>
          <span v-if="r.published_date" class="font-mono text-xs text-[var(--paper-3)]">· {{ fmtDate(r.published_date) }}</span>
        </div>
        <a :href="r.url" target="_blank" rel="noopener noreferrer" class="block text-base font-medium text-[var(--paper-0)] hover:text-[var(--accent)] transition-colors leading-snug">
          {{ r.title }}
        </a>
        <p class="text-base text-[var(--paper-2)] mt-2 line-clamp-2 leading-snug">{{ r.content }}</p>
      </li>
    </ul>
  </div>
</template>
