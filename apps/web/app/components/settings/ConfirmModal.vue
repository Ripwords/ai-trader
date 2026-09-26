<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  confirmLabel: string
}>()

const emit = defineEmits<{ close: [confirmed: boolean] }>()
</script>

<template>
  <UModal
    :title="title"
    :description="description"
    :close="{ onClick: () => emit('close', false) }"
    :ui="{ footer: 'justify-end' }"
  >
    <template #footer>
      <UButton label="Cancel" color="neutral" variant="outline" @click="emit('close', false)" />
      <UButton :label="confirmLabel" color="error" @click="emit('close', true)" />
    </template>
  </UModal>
</template>
