<script setup lang="ts">
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
  <div class="min-h-screen flex items-center justify-center">
    <UCard class="w-96">
      <template #header>
        <h2 class="text-lg font-semibold">Sign in</h2>
      </template>
      <UForm :state="{ password }" @submit="submit">
        <UFormField label="Password" required>
          <UInput v-model="password" type="password" autofocus />
        </UFormField>
        <p v-if="error" class="mt-2 text-sm text-red-500">{{ error }}</p>
        <UButton class="mt-4 w-full" type="submit" :loading="loading">Sign in</UButton>
      </UForm>
    </UCard>
  </div>
</template>
