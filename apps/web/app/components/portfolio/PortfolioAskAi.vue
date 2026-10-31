<script setup lang="ts">
// Questions that open the chat with the plan tools behind them. Each link
// fills the chat box, so the question can be edited before it is sent.
const PROMPTS = [
  { label: 'am I on track?', text: 'Am I on track with my plan? Check my emergency fund, savings rate, debts and how far each bucket is from its target.' },
  { label: 'tailor my ideal split', text: 'Help me tailor my ideal wealth distribution. Look at my plan first, ask me what you need to know, then propose a target allocation with a reason for each bucket.' },
  { label: 'what to buy this month', text: 'With my monthly contribution, what should I buy this month to get closer to my target? Do not place any orders.' },
  { label: 'full rebalance plan', text: 'What trades would fully rebalance my portfolio to my target allocation, and which would realise gains? Do not place any orders.' },
  { label: 'diversification check', text: 'How concentrated and correlated is my portfolio, and what would diversify it within my target allocation?' },
] as const
</script>

<template>
  <section class="surface-1 p-4 sm:p-6 space-y-3" aria-label="ask the assistant">
    <div class="space-y-1">
      <h2 class="label-eyebrow">ask the assistant</h2>
      <p class="text-sm text-[var(--paper-3)]">
        It reads this plan, can change its targets and inputs when you ask, and drafts trades without placing them.
      </p>
    </div>
    <ul class="flex flex-wrap gap-2">
      <li v-for="p in PROMPTS" :key="p.label">
        <NuxtLink :to="{ path: '/', query: { ask: p.text } }" class="ask-chip tap">{{ p.label }}</NuxtLink>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.ask-chip {
  display: inline-flex;
  align-items: center;
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--ink-line-strong);
  border-radius: 999px;
  font-size: 0.875rem;
  color: var(--paper-1);
}
.ask-chip:hover,
.ask-chip:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
