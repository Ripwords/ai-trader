<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

interface SymbolHit {
  moomoo: string | null
  yahoo: string
  name: string
  exchange: string
  type: string
}

interface Props {
  modelValue: string
  placeholder?: string
}

const props = withDefaults(defineProps<Props>(), { placeholder: 'US.NVDA' })
const emit = defineEmits<{
  'update:modelValue': [string]
  'select': [SymbolHit]
  'submit': [string]
}>()

const open = ref(false)
const focused = ref(false)
const hits = ref<SymbolHit[]>([])
const loading = ref(false)
const cursor = ref(-1)
const wrapper = ref<HTMLElement | null>(null)

let debounceId: ReturnType<typeof setTimeout> | null = null
let abortCtrl: AbortController | null = null

function emitInput(v: string) { emit('update:modelValue', v) }

watch(() => props.modelValue, (v) => {
  if (debounceId) clearTimeout(debounceId)
  if (abortCtrl) abortCtrl.abort()
  if (!v || !v.trim()) {
    hits.value = []
    open.value = false
    loading.value = false
    return
  }
  loading.value = true
  debounceId = setTimeout(async () => {
    abortCtrl = new AbortController()
    try {
      const r = await $fetch<{ results: SymbolHit[] }>('/api/research/symbol-search', {
        query: { q: v.trim(), limit: 8 },
        signal: abortCtrl.signal,
      })
      hits.value = r.results
      open.value = focused.value && r.results.length > 0
      cursor.value = -1
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        console.error('[symbol-search] failed', err)
        hits.value = []
        open.value = false
      }
    } finally {
      loading.value = false
    }
  }, 180)
})

function onFocus() { focused.value = true; if (hits.value.length > 0) open.value = true }
function onBlur() {
  focused.value = false
  // Allow click-on-hit to register before closing
  setTimeout(() => { open.value = false }, 120)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    if (!open.value && hits.value.length > 0) { open.value = true; return }
    cursor.value = Math.min(hits.value.length - 1, cursor.value + 1)
    e.preventDefault()
  } else if (e.key === 'ArrowUp') {
    cursor.value = Math.max(-1, cursor.value - 1)
    e.preventDefault()
  } else if (e.key === 'Enter') {
    const choice = open.value && cursor.value >= 0 ? hits.value[cursor.value] : undefined
    if (choice) {
      pick(choice)
      e.preventDefault()
    } else {
      emit('submit', props.modelValue)
    }
  } else if (e.key === 'Escape') {
    open.value = false
    cursor.value = -1
  }
}

function pick(hit: SymbolHit) {
  const value = hit.moomoo ?? hit.yahoo
  emitInput(value)
  emit('select', hit)
  nextTick(() => { open.value = false; cursor.value = -1 })
}

const showFootnote = computed(() => loading.value || (open.value && hits.value.length === 0))

onBeforeUnmount(() => {
  if (debounceId) clearTimeout(debounceId)
  if (abortCtrl) abortCtrl.abort()
})
</script>

<template>
  <div ref="wrapper" class="sym-wrap">
    <input
      type="text"
      class="sym-input"
      :value="props.modelValue"
      :placeholder="props.placeholder"
      autocomplete="off"
      spellcheck="false"
      autocorrect="off"
      autocapitalize="characters"
      @input="emitInput(($event.target as HTMLInputElement).value)"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKey"
    >
    <span v-if="loading" class="sym-spinner" aria-hidden="true" />

    <Transition name="menu">
      <div v-if="open && hits.length > 0" class="sym-menu" role="listbox">
        <div class="sym-rows">
          <button
            v-for="(h, i) in hits"
            :key="`${h.yahoo}-${i}`"
            type="button"
            class="sym-row"
            :class="{ 'is-cursor': cursor === i, 'is-untradable': !h.moomoo }"
            role="option"
            :aria-selected="cursor === i"
            @mousedown.prevent="pick(h)"
            @mouseenter="cursor = i"
          >
            <span class="sym-row-sym">{{ h.moomoo ?? h.yahoo }}</span>
            <span class="sym-row-name">{{ h.name }}</span>
            <span class="sym-row-meta">
              <span>{{ h.exchange }}</span>
              <span class="sym-row-type">{{ h.type }}</span>
            </span>
          </button>
        </div>
        <div class="sym-foot">↑↓ to navigate · enter to pick · esc to close</div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.sym-wrap {
  position: relative;
  width: 100%;
}

.sym-input {
  display: block;
  width: 100%;
  padding: 0.6rem 0.85rem;
  background: var(--ink-2);
  border: 1px solid var(--hairline, rgba(255,245,230,0.12));
  border-radius: 6px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.95rem;
  letter-spacing: 0.04em;
  color: var(--paper-0);
  outline: none;
  transition: border-color 160ms ease, background-color 160ms ease;
}
.sym-input::placeholder { color: var(--paper-3); }
.sym-input:focus {
  border-color: var(--accent);
  background: var(--ink-0);
}

.sym-spinner {
  position: absolute;
  right: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  width: 12px;
  height: 12px;
  border: 1.5px solid rgba(212, 169, 106, 0.3);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 720ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.sym-menu {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  background: var(--ink-0);
  border: 1px solid var(--hairline, rgba(255,245,230,0.14));
  border-radius: 6px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.55);
  max-height: 360px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sym-rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.menu-enter-active, .menu-leave-active {
  transition: opacity 140ms ease, transform 160ms cubic-bezier(0.6, 0, 0.2, 1);
}
.menu-enter-from, .menu-leave-to { opacity: 0; transform: translateY(-4px); }

.sym-row {
  display: grid;
  grid-template-columns: minmax(110px, auto) 1fr auto;
  gap: 0.85rem;
  align-items: baseline;
  width: 100%;
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid var(--hairline, rgba(255,245,230,0.06));
  background: transparent;
  transition: background-color 120ms ease;
}
.sym-row:last-of-type { border-bottom: none; }
.sym-row.is-cursor { background: var(--ink-2); }
.sym-row.is-untradable { opacity: 0.55; }

.sym-row-sym {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.85rem;
  letter-spacing: 0.02em;
  color: var(--paper-0);
  font-weight: 500;
}
.sym-row.is-untradable .sym-row-sym { color: var(--paper-3); }
.sym-row.is-cursor .sym-row-sym { color: var(--accent); }

.sym-row-name {
  font-size: 0.8rem;
  color: var(--paper-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.sym-row-meta {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.6rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  white-space: nowrap;
}
.sym-row-type { opacity: 0.6; font-size: 0.55rem; }

.sym-foot {
  flex-shrink: 0;
  padding: 0.5rem 0.85rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-3);
  background: var(--ink-2);
  border-top: 1px solid var(--hairline, rgba(255,245,230,0.06));
}
</style>
