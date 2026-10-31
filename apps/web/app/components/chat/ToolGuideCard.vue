<script setup lang="ts">
import type { ToolGuide } from '~~/types/tool-guide'

defineProps<{ guide: ToolGuide }>()
const emit = defineEmits<{ use: [text: string] }>()
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden tg-card">
    <details
      v-for="cat in guide.categories"
      :key="cat.category"
      data-testid="tool-guide-category"
      class="tg-category"
    >
      <summary class="tg-summary">
        <span class="tg-summary-head">
          <span class="tg-category-name">{{ cat.category }}</span>
          <span class="tg-count">{{ cat.tools.length }} {{ cat.tools.length === 1 ? 'tool' : 'tools' }}</span>
        </span>
        <span class="tg-blurb">{{ cat.blurb }}</span>
      </summary>
      <ul class="tg-tools">
        <li v-for="t in cat.tools" :key="t.name" class="tg-tool">
          <p class="tg-what">{{ t.what }}</p>
          <p class="tg-when">Use when: {{ t.useWhen }}</p>
          <div class="tg-meta">
            <button
              type="button"
              data-testid="tool-guide-example"
              class="tg-example"
              :title="`Put “${t.example}” in the composer`"
              @click="emit('use', t.example)"
            >
              {{ t.example }}
            </button>
            <span v-for="s in t.slash" :key="s" class="tg-slash">/{{ s }}</span>
            <span class="tg-name">{{ t.name }}</span>
          </div>
        </li>
      </ul>
    </details>

    <section v-if="guide.commands.length" class="tg-commands">
      <h3 class="tg-section-title">Slash commands</h3>
      <ul class="tg-command-list">
        <li v-for="c in guide.commands" :key="c.name" class="tg-command-row">
          <button
            type="button"
            data-testid="tool-guide-command"
            class="tg-command"
            :title="`Start /${c.name} in the composer`"
            @click="emit('use', `/${c.name} `)"
          >
            {{ c.usage }}
          </button>
          <span class="tg-command-desc">{{ c.description }}</span>
        </li>
      </ul>
    </section>

    <ul v-if="guide.notes.length" class="tg-notes">
      <li v-for="(n, i) in guide.notes" :key="i">{{ n }}</li>
    </ul>
  </div>
</template>

<style scoped>
.tg-card {
  font-size: 0.875rem;
  line-height: 1.5;
}

.tg-category + .tg-category,
.tg-commands,
.tg-notes {
  border-top: 1px solid rgba(255, 245, 230, 0.08);
}

.tg-summary {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
  list-style: none;
}
.tg-summary::-webkit-details-marker { display: none; }
.tg-summary-head::before {
  content: '▸';
  width: 0.75rem;
  color: var(--paper-3);
}
.tg-category[open] .tg-summary-head::before { content: '▾'; }
.tg-summary:hover { background: rgba(255, 245, 230, 0.03); }

.tg-summary-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.tg-category-name {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--paper-0);
}
.tg-count {
  font-family: var(--font-mono);
  color: var(--paper-3);
}
.tg-blurb {
  color: var(--paper-2);
  padding-left: 1.35rem;
}

.tg-tools {
  display: flex;
  flex-direction: column;
  padding: 0 1rem 0.75rem;
}
.tg-tool {
  padding: 0.6rem 0;
  border-top: 1px dashed rgba(255, 245, 230, 0.06);
}
.tg-what { color: var(--paper-0); }
.tg-when { color: var(--paper-2); }

.tg-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.6rem;
  margin-top: 0.4rem;
}
.tg-example,
.tg-command {
  text-align: left;
  padding: 0.2rem 0.6rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(255, 245, 230, 0.12);
  color: var(--accent);
  background: rgba(255, 245, 230, 0.02);
  cursor: pointer;
}
.tg-example:hover,
.tg-command:hover { border-color: var(--accent); }
.tg-example:focus-visible,
.tg-command:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.tg-example::before { content: '“'; }
.tg-example::after { content: '”'; }

.tg-slash,
.tg-name {
  font-family: var(--font-mono);
  color: var(--paper-3);
  min-width: 0;
  overflow-wrap: anywhere;
}
.tg-slash { color: var(--paper-2); }

.tg-commands { padding: 0.75rem 1rem; }
.tg-section-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--paper-0);
  margin-bottom: 0.4rem;
}
.tg-command-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.tg-command-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.75rem;
}
.tg-command {
  font-family: var(--font-mono);
  max-width: 100%;
  overflow-wrap: anywhere;
}
.tg-command-desc { color: var(--paper-2); }

.tg-notes {
  padding: 0.6rem 1rem;
  color: var(--paper-2);
}
</style>
