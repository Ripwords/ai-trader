<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { PlanningCashflowKind, PlanningSettings } from '../../../server/lib/planning'

const props = defineProps<{
  settings: PlanningSettings | null
  saving: boolean
  error: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ save: [settings: PlanningSettings] }>()

const draft = ref<PlanningSettings | null>(null)
watch(open, (isOpen) => {
  if (isOpen && props.settings) draft.value = structuredClone(toRaw(props.settings))
}, { immediate: true })

const BUCKET_COLOR: Record<string, string> = {
  cash: 'var(--paper-3)',
  equity: 'var(--accent)',
  bond: 'var(--tape-up)',
}
const bucketColor = (key: string) => BUCKET_COLOR[key] ?? 'var(--paper-2)'

const targetTotal = computed(() => draft.value?.target_model.reduce((sum, t) => sum + Number(t.target_pct || 0), 0) ?? 0)
const targetsBalanced = computed(() => Math.abs(targetTotal.value - 100) < 0.01)
const targetState = computed(() => {
  if (targetsBalanced.value) return 'adds up to 100%'
  const d = Math.round((targetTotal.value - 100) * 100) / 100
  return `${Math.abs(d)}% ${d > 0 ? 'over' : 'under'}`
})

// Rescale every bucket proportionally; the last absorbs the rounding so the
// total lands on exactly 100. An all-zero model splits evenly.
function normalizeTargets() {
  const model = draft.value?.target_model
  if (!model || model.length === 0) return
  const sum = model.reduce((acc, t) => acc + Number(t.target_pct || 0), 0)
  let running = 0
  model.forEach((t, i) => {
    if (i === model.length - 1) {
      t.target_pct = Math.round((100 - running) * 100) / 100
      return
    }
    const next = sum > 0
      ? Math.round((Number(t.target_pct || 0) / sum) * 100 * 100) / 100
      : Math.round((100 / model.length) * 100) / 100
    t.target_pct = next
    running += next
  })
}

function addLiability() {
  draft.value?.liabilities.push({ id: `liability-${Date.now()}`, name: 'Loan', balance: 0, interest_rate_pct: 0, minimum_payment: 0 })
}
function removeLiability(id: string) {
  if (draft.value) draft.value.liabilities = draft.value.liabilities.filter(r => r.id !== id)
}

const CASHFLOW_KINDS: { value: PlanningCashflowKind, label: string }[] = [
  { value: 'income', label: 'income' },
  { value: 'expense', label: 'expense' },
  { value: 'saving', label: 'saving' },
]
function addCashflow(kind: PlanningCashflowKind) {
  draft.value?.cashflow_items.push({ id: `${kind}-${Date.now()}`, name: kind, kind, amount: 0 })
}
function removeCashflow(id: string) {
  if (draft.value) draft.value.cashflow_items = draft.value.cashflow_items.filter(r => r.id !== id)
}

function submit() {
  if (draft.value && targetsBalanced.value) emit('save', draft.value)
}
</script>

<template>
  <USlideover v-model:open="open" title="edit plan" description="targets, reserve, debts and monthly cashflow">
    <template #body>
      <PageState v-if="!draft" kind="loading" message="loading plan…" />
      <form v-else id="plan-editor" class="space-y-8" @submit.prevent="submit">
        <fieldset class="space-y-3">
          <legend class="label-eyebrow mb-3">target allocation</legend>
          <div class="mix" aria-hidden="true">
            <span
              v-for="t in draft.target_model"
              :key="`seg-${t.key}`"
              :style="{ width: `${targetTotal > 0 ? (Number(t.target_pct || 0) / targetTotal) * 100 : 0}%`, background: bucketColor(t.key) }"
            />
          </div>
          <UFormField v-for="t in draft.target_model" :key="t.key" :label="t.label" :name="`target-${t.key}`">
            <template #label>
              <span class="inline-flex items-center gap-2">
                <span class="w-2 h-2 rounded-full" :style="{ background: bucketColor(t.key) }" />{{ t.label }}
              </span>
            </template>
            <UInput v-model.number="t.target_pct" type="number" min="0" max="100" step="1" class="w-full">
              <template #trailing><span class="text-xs text-[var(--paper-3)]">%</span></template>
            </UInput>
          </UFormField>
          <div class="flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
            <span :class="targetsBalanced ? 'text-[var(--paper-3)]' : 'text-[var(--tape-down)]'" role="status">
              total {{ targetTotal.toFixed(targetTotal % 1 === 0 ? 0 : 1) }}% · {{ targetState }}
            </span>
            <UButton v-if="!targetsBalanced" size="xs" variant="soft" label="scale to 100%" @click="normalizeTargets()" />
          </div>
        </fieldset>

        <fieldset class="space-y-3">
          <legend class="label-eyebrow mb-3">cash reserve</legend>
          <UFormField label="monthly expenses" name="monthly_expenses">
            <UInput v-model.number="draft.monthly_expenses" type="number" min="0" step="100" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="months to hold" name="emergency_fund_months">
              <UInput v-model.number="draft.emergency_fund_months" type="number" min="0" max="36" step="1" class="w-full" />
            </UFormField>
            <UFormField label="invest / month" name="monthly_contribution">
              <UInput v-model.number="draft.monthly_contribution" type="number" min="0" step="100" class="w-full" />
            </UFormField>
          </div>
        </fieldset>

        <section class="space-y-3" aria-labelledby="plan-debts">
          <div class="flex items-center justify-between gap-3">
            <h3 id="plan-debts" class="label-eyebrow">debts</h3>
            <UButton size="xs" variant="outline" color="neutral" label="add debt" @click="addLiability()" />
          </div>
          <p v-if="draft.liabilities.length === 0" class="font-mono text-xs text-[var(--paper-3)]">no debts tracked</p>
          <div v-for="l in draft.liabilities" :key="l.id" class="row">
            <div class="flex items-end gap-2">
              <UFormField label="name" :name="`${l.id}-name`" class="flex-1 min-w-0">
                <UInput v-model="l.name" class="w-full" />
              </UFormField>
              <UButton variant="ghost" color="neutral" label="remove" :aria-label="`remove ${l.name}`" @click="removeLiability(l.id)" />
            </div>
            <div class="grid grid-cols-3 gap-2">
              <UFormField label="balance" :name="`${l.id}-balance`">
                <UInput v-model.number="l.balance" type="number" min="0" step="100" class="w-full" />
              </UFormField>
              <UFormField label="rate %" :name="`${l.id}-rate`">
                <UInput v-model.number="l.interest_rate_pct" type="number" min="0" max="100" step="0.1" class="w-full" />
              </UFormField>
              <UFormField label="min / mo" :name="`${l.id}-min`">
                <UInput v-model.number="l.minimum_payment" type="number" min="0" step="50" class="w-full" />
              </UFormField>
            </div>
          </div>
        </section>

        <fieldset class="space-y-3">
          <legend class="label-eyebrow mb-1">monthly cashflow</legend>
          <p class="font-mono text-xs text-[var(--paper-3)]">
            {{ draft.cashflow_items.length === 0 ? 'none yet; the reserve numbers above are used instead' : 'these lines replace the reserve numbers above' }}
          </p>
          <div v-for="c in draft.cashflow_items" :key="c.id" class="row">
            <div class="flex items-end gap-2">
              <UFormField label="name" :name="`${c.id}-name`" class="flex-1 min-w-0">
                <UInput v-model="c.name" class="w-full" />
              </UFormField>
              <UButton variant="ghost" color="neutral" label="remove" :aria-label="`remove ${c.name}`" @click="removeCashflow(c.id)" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="kind" :name="`${c.id}-kind`">
                <USelect v-model="c.kind" :items="CASHFLOW_KINDS" class="w-full" />
              </UFormField>
              <UFormField label="amount / mo" :name="`${c.id}-amount`">
                <UInput v-model.number="c.amount" type="number" min="0" step="100" class="w-full" />
              </UFormField>
            </div>
          </div>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="k in CASHFLOW_KINDS"
              :key="k.value"
              size="xs"
              variant="outline"
              color="neutral"
              :label="`add ${k.label}`"
              @click="addCashflow(k.value)"
            />
          </div>
        </fieldset>
      </form>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-3">
        <span class="font-mono text-xs" :class="error ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'" :role="error ? 'alert' : undefined">
          {{ error || (targetsBalanced ? '' : 'targets must add up to 100% to save') }}
        </span>
        <div class="flex gap-2 ml-auto">
          <UButton color="neutral" variant="outline" label="cancel" @click="open = false" />
          <UButton type="submit" form="plan-editor" label="save plan" :loading="saving" :disabled="!targetsBalanced" />
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.mix {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--ink-3);
}
.mix > span { height: 100%; transition: width 200ms ease-out; }
.row {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--ink-line);
  border-radius: var(--radius-card);
}
</style>
