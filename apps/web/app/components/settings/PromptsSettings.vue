<script setup lang="ts">
import PromptEditor from '~/components/settings/PromptEditor.vue'
import { groupPrompts } from '../../utils/settings-view'
import type { PromptListResponse } from '../../../types/prompts'

const { data, pending, error, refresh } = useFetch<PromptListResponse>('/api/settings/prompts', { key: 'prompts' })

const groups = computed(() => groupPrompts(data.value?.prompts ?? []))
const agentsError = computed(() => data.value?.agentsError ?? null)

const open = reactive<Record<string, boolean>>({})
function toggle(id: string): void {
  open[id] = !open[id]
}
</script>

<template>
  <div class="space-y-10">
    <p class="text-sm text-[var(--paper-2)]">
      The instructions each model gets. Edits apply to the next chat message, report or debate run; nothing already running changes.
      A prompt you have not edited follows the built-in default, including future updates to it.
    </p>

    <PageState v-if="pending && !data" kind="loading" message="loading prompts…" />
    <PageState v-else-if="error" kind="error" :message="`prompts failed to load: ${error.message}`" @retry="refresh()" />

    <template v-else>
      <section v-for="g in groups" :key="g.group" class="space-y-4">
        <h2 class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">{{ g.label }}</h2>

        <PageState v-if="g.group === 'agents' && agentsError" kind="error" :message="agentsError" @retry="refresh()" />

        <ul class="space-y-3">
          <li v-for="p in g.prompts" :key="p.id" class="surface-1">
            <button
              type="button"
              class="w-full text-left p-4 flex items-start gap-3 tap disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="p.default === null"
              :aria-expanded="open[p.id] ? 'true' : 'false'"
              @click="toggle(p.id)"
            >
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-[var(--paper-0)]">{{ p.label }}</span>
                  <UBadge v-if="p.modified" label="modified" color="warning" variant="subtle" size="sm" />
                </div>
                <p class="text-sm text-[var(--paper-2)] mt-1">{{ p.description }}</p>
              </div>
              <UIcon
                name="i-lucide-chevron-down"
                class="shrink-0 mt-1 text-[var(--paper-3)] transition-transform"
                :class="open[p.id] ? 'rotate-180' : ''"
              />
            </button>
            <div v-if="open[p.id] && p.default !== null" class="px-4 pb-4">
              <PromptEditor :prompt="p" @saved="refresh()" />
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
