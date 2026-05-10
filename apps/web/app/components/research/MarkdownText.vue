<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'

interface Props {
  /** Markdown source. LLM output is GFM-flavoured: headings, bold, lists,
   *  fenced code, the occasional table. We do NOT pass HTML through. */
  content: string
  /** When true, top/bottom margins on the first/last block elements are
   *  collapsed so the rendered prose hugs its container. Useful for the
   *  step-summary block where the parent already controls spacing. */
  flush?: boolean
}
const props = withDefaults(defineProps<Props>(), { flush: false })

// Configure once. ``mangle`` and ``headerIds`` deprecated/removed in marked 12+;
// we rely on the defaults. ``gfm: true`` enables GitHub-flavoured extras
// (tables, strikethrough); ``breaks: true`` turns single newlines into <br>
// because LLMs format reports with soft wraps that they expect to render.
marked.use({
  gfm: true,
  breaks: true,
  // Disable raw HTML in source — never trust LLM-emitted markup. ``escape``
  // around any embedded HTML keeps it as visible text.
  async: false,
})

const html = computed(() => {
  // marked.parse with default escaping is safe for our LLM-as-author use:
  // it escapes < and & in source, so a model that emits a raw <script> tag
  // ends up rendered as literal characters, not executed.
  return marked.parse(props.content || '', { async: false }) as string
})
</script>

<template>
  <div
    class="md"
    :class="{ 'md--flush': flush }"
    v-html="html"
  />
</template>

<style scoped>
/* ─────────────────────────────────────────────────────────────────────
   Markdown styles for analyst reports / verdict rationales / debate text.
   The LLM emits structured prose; we want it to read like a wire-service
   research note, not a Notion document. Strict typographic hierarchy,
   monospace details, accent reserved for emphasis only.
   ───────────────────────────────────────────────────────────────────── */

.md {
  color: var(--paper-1);
  font-size: 0.92rem;
  line-height: 1.65;
  letter-spacing: 0.005em;
  max-width: 65ch;
}
.md--flush :first-child { margin-top: 0; }
.md--flush :last-child  { margin-bottom: 0; }

/* ─── Headings: small-caps display, accent rule below ─── */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-0);
  margin: 1.6rem 0 0.7rem;
  padding-bottom: 0.35rem;
  border-bottom: 1px solid var(--ink-line);
}
.md :deep(h1) { font-size: 0.92rem; }
.md :deep(h2) { font-size: 0.85rem; color: var(--accent); }
.md :deep(h3) { font-size: 0.78rem; color: var(--accent); border-bottom: 0; padding-bottom: 0; margin-bottom: 0.45rem; }
.md :deep(h4) { font-size: 0.74rem; color: var(--paper-2); border-bottom: 0; padding-bottom: 0; }
.md :deep(h5),
.md :deep(h6) { font-size: 0.7rem; color: var(--paper-3); border-bottom: 0; padding-bottom: 0; }

/* ─── Paragraphs ─── */
.md :deep(p) { margin: 0.6rem 0; }
.md :deep(p:first-child) { margin-top: 0; }
.md :deep(p:last-child)  { margin-bottom: 0; }

/* ─── Strong / emphasis ─── */
.md :deep(strong) {
  color: var(--paper-0);
  font-weight: 600;
}
.md :deep(em) {
  color: var(--paper-0);
  font-style: italic;
}
.md :deep(del) {
  color: var(--paper-3);
  text-decoration: line-through;
  text-decoration-color: var(--paper-3);
}

/* ─── Lists ─── */
.md :deep(ul),
.md :deep(ol) {
  margin: 0.6rem 0;
  padding-left: 1.4rem;
}
.md :deep(li) {
  margin: 0.35rem 0;
  padding-left: 0.2rem;
}
.md :deep(ul) {
  list-style: none;
  padding-left: 0;
}
.md :deep(ul > li) {
  padding-left: 1.4rem;
  position: relative;
}
.md :deep(ul > li)::before {
  /* Custom bullet: a thin dash, accent-coloured, tabular-aligned. */
  content: "—";
  position: absolute;
  left: 0;
  color: var(--accent);
  font-family: var(--font-mono);
  font-weight: 500;
}
.md :deep(ul > li > ul > li)::before { content: "·"; color: var(--paper-3); }

/* ─── Code ─── */
.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.84em;
  padding: 0.05rem 0.32rem;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-radius: 2px;
  color: var(--paper-0);
}
.md :deep(pre) {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.55;
  background: var(--ink-2);
  border: 1px solid var(--ink-line);
  border-left: 2px solid var(--accent);
  border-radius: 3px;
  padding: 0.7rem 0.9rem;
  margin: 0.8rem 0;
  overflow-x: auto;
}
.md :deep(pre code) {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: inherit;
}

/* ─── Blockquotes — pull-quote style ─── */
.md :deep(blockquote) {
  margin: 0.8rem 0;
  padding: 0.45rem 0 0.45rem 1rem;
  border-left: 2px solid var(--accent);
  color: var(--paper-1);
  font-style: italic;
}
.md :deep(blockquote p) { margin: 0.3rem 0; }

/* ─── Tables ─── */
.md :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8rem 0;
  font-size: 0.82rem;
}
.md :deep(thead th) {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  text-align: left;
  color: var(--paper-3);
  padding: 0.5rem 0.7rem;
  border-bottom: 1px solid var(--ink-line-strong);
}
.md :deep(tbody td) {
  padding: 0.45rem 0.7rem;
  border-bottom: 1px solid var(--ink-line);
  vertical-align: top;
}
.md :deep(tbody tr:hover td) { background: rgba(255, 245, 230, 0.015); }

/* ─── Links ─── */
.md :deep(a) {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  text-decoration-color: color-mix(in srgb, var(--accent) 50%, transparent);
}
.md :deep(a:hover) {
  text-decoration-color: var(--accent);
}

/* ─── Horizontal rule ─── */
.md :deep(hr) {
  margin: 1.4rem 0;
  border: 0;
  border-top: 1px solid var(--ink-line);
}
</style>
