<script setup lang="ts">
definePageMeta({ layout: false })

const password = ref('')
const error = ref<string | null>(null)
const loading = ref(false)

async function submit() {
  error.value = null
  loading.value = true
  try {
    await $fetch('/api/login', { method: 'POST', body: { password: password.value } })
    await navigateTo('/')
  } catch (e: unknown) {
    error.value = (e as { statusMessage?: string })?.statusMessage ?? 'login failed'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-[var(--ink-0)] text-[var(--paper-0)] relative overflow-hidden">
    <!-- Decorative wide hairline cross — anchors the empty space -->
    <div class="absolute inset-0 pointer-events-none">
      <div class="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--ink-line-strong)] opacity-50" />
      <div class="absolute top-1/2 left-0 right-0 h-px bg-[var(--ink-line-strong)] opacity-50" />
    </div>

    <div class="relative z-10 w-[420px] px-8 rise-in">
      <div class="mb-12 text-center">
        <div class="brand-mark" style="font-size: 2.25rem;">
          <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
        </div>
        <div class="font-mono text-xs uppercase tracking-[0.25em] text-[var(--paper-3)] mt-3">
          copilot · sign in
        </div>
      </div>

      <form class="space-y-6" @submit.prevent="submit">
        <div>
          <label class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] block mb-3">
            password
          </label>
          <input
            v-model="password"
            type="password"
            autofocus
            spellcheck="false"
            class="w-full bg-transparent border-b hairline-strong border-b py-3 px-1 font-mono text-base text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
          />
        </div>

        <div v-if="error" class="font-mono text-sm text-[var(--tape-down)]">
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading || !password"
          class="w-full py-3.5 font-mono text-xs uppercase tracking-[0.22em] text-[var(--ink-0)] bg-[var(--accent)] hover:bg-[var(--paper-0)] disabled:opacity-30 transition-colors"
        >
          <span v-if="loading">authenticating…</span>
          <span v-else>enter</span>
        </button>
      </form>

      <div class="mt-14 text-center font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
        <span>moomoo · {{ new Date().getFullYear() }}</span>
      </div>
    </div>
  </div>
</template>
