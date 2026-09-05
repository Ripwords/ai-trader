<script setup lang="ts">
// The per-page bar under the global app header. Eight pages had grown their
// own copy of this — six as the literal Tailwind string
// `px-7 h-16 flex items-center justify-between border-b hairline shrink-0`,
// two as scoped `.page-header` CSS — and none of them survived a phone
// viewport. One component, two slots, responsive once.
</script>

<template>
  <header class="page-header">
    <div class="page-header__lead">
      <slot name="lead" />
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  min-height: 4rem;
  padding: 0.5rem var(--page-x);
  border-bottom: 1px solid var(--ink-line);
  flex-shrink: 0;
  /* Phones wrap the actions under the title instead of squeezing both onto
     one 390px line, which is what pushed /research/report past the viewport. */
  flex-wrap: wrap;
}

.page-header__lead {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.5rem 0.7rem;
  min-width: 0;
  /* A breadcrumb nested here is itself a flex row; without this it reports its
     max-content width and overflows the lead box on a phone. */
  max-width: 100%;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-3);
}
/* A nested breadcrumb defaults to min-width:auto and reports its max-content
   width, which is what pushed it 7px past the lead box on a phone. */
.page-header__lead > :deep(*) {
  min-width: 0;
  max-width: 100%;
}

.page-header__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  min-width: 0;
  /* Typography sits on the container so it reaches the slotted controls by
     inheritance. Setting it on the descendants instead loses to Tailwind
     preflight's `button { font: inherit }`, which left every action button
     rendering at the 16px body size while the links resolved to 12px. A page
     that wants a different size puts a utility on the element itself, which
     still wins over an inherited value. */
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

/* Actions are authored as bare links and buttons by the consuming pages.
   Styling them from here keeps every page's header consistent and gets the
   touch target without each page repeating a `.tap` class.

   These live in @layer components on purpose. Vue's scoped CSS is unlayered,
   and unlayered rules beat every layered one regardless of specificity — so an
   unlayered `display: inline-flex` here silently defeats a Tailwind `md:hidden`
   on a consuming page's action button. Tailwind emits utilities into
   @layer utilities, which outranks components, so this keeps utilities winning. */
/* Preflight resets font, letter-spacing and text-transform directly on
   <button>, and a directly-applied declaration beats an inherited one whatever
   layer it sits in — so the container's typography above reaches links but
   stops at buttons, which is what left `refresh` lowercase next to an
   uppercase `RESEARCH`. Handing the reset back to inheritance fixes it, and
   this stays unlayered so it outranks preflight. */
.page-header__actions :deep(button) {
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}

@layer components {
  .page-header__actions :deep(a),
  .page-header__actions :deep(button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    white-space: nowrap;
  }

  @media (pointer: coarse) {
    .page-header__actions :deep(a),
    .page-header__actions :deep(button) {
      min-height: 44px;
    }
  }
}

@media (min-width: 768px) {
  .page-header {
    flex-wrap: nowrap;
    height: 4rem;
    padding: 0 var(--page-x);
  }
  .page-header__lead { flex-wrap: nowrap; }
  .page-header__actions { flex-wrap: nowrap; flex-shrink: 0; }
}
</style>
