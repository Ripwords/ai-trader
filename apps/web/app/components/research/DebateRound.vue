<script setup lang="ts">
import MarkdownText from './MarkdownText.vue'
defineProps<{ round: number; bull: string; bear: string }>()
</script>

<template>
  <section class="debate" data-testid="debate-round">
    <header class="debate__head">
      <span class="debate__rule" aria-hidden="true">═</span>
      <span class="debate__eyebrow">
        debate <span class="debate__round" data-mono>r{{ round }}</span>
      </span>
      <span class="debate__rule debate__rule--right" aria-hidden="true">═</span>
    </header>

    <div class="debate__cols">
      <article class="debate__col" data-side="bull">
        <span class="debate__side">
          <span class="debate__arrow" data-mono aria-hidden="true">▲</span>
          bull
        </span>
        <MarkdownText v-if="bull" :content="bull" flush class="debate__text" />
        <p v-else class="debate__text debate__text--empty">—</p>
      </article>

      <div class="debate__divider" aria-hidden="true" />

      <article class="debate__col" data-side="bear">
        <span class="debate__side">
          <span class="debate__arrow" data-mono aria-hidden="true">▼</span>
          bear
        </span>
        <MarkdownText v-if="bear" :content="bear" flush class="debate__text" />
        <p v-else class="debate__text debate__text--empty">—</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.debate {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1rem 0;
  /* No surface card here — debate sits inline in the timeline as a quoted
     dialogue, separated only by typographic devices. */
}

.debate__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.debate__rule {
  flex: 1;
  letter-spacing: 0.05em;
  color: var(--ink-line-strong);
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
}
.debate__rule--right { text-align: right; }
.debate__eyebrow { color: var(--accent); }
.debate__round {
  color: var(--paper-2);
  margin-left: 0.3rem;
}

.debate__cols {
  display: grid;
  grid-template-columns: 1fr;
  gap: 0.7rem;
  align-items: stretch;
}
.debate__divider { display: none; }

@media (min-width: 720px) {
  .debate__cols {
    grid-template-columns: 1fr 1px 1fr;
    gap: 1.4rem;
  }
  .debate__divider {
    display: block;
    background: var(--ink-line-strong);
    /* The vertical hairline is the literal "vs" separator — leans hard
       into the editorial-column metaphor. */
    background-image: linear-gradient(
      180deg,
      transparent 0%,
      var(--ink-line-strong) 12%,
      var(--ink-line-strong) 88%,
      transparent 100%
    );
  }
}

.debate__col {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.4rem 0.2rem;
  min-width: 0;
}
.debate__col[data-side="bear"] { text-align: left; }

.debate__side {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
.debate__col[data-side="bull"] .debate__side { color: var(--tape-up); }
.debate__col[data-side="bear"] .debate__side { color: var(--tape-down); }
.debate__arrow {
  font-size: 0.85rem;
  letter-spacing: 0;
}

.debate__text {
  /* MarkdownText brings its own typographic styling. We only constrain the
     measure so each side stays in its column without bleeding wide. */
  max-width: 50ch;
}
.debate__text--empty {
  margin: 0;
  font-family: var(--font-mono);
  color: var(--paper-3);
}
.debate__col[data-side="bear"] .debate__text {
  /* Bear sits visually quieter — the page should feel like a reasoned
     contrarian voice, not a screaming red box. */
  opacity: 0.96;
}
</style>
