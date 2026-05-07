<script setup lang="ts">
interface NewsItem { title: string; url: string; content: string; published_date?: string }
const props = defineProps<{ results: NewsItem[] }>()
</script>

<template>
  <UCard>
    <template #header>
      <div class="font-medium">News</div>
    </template>
    <ul class="space-y-3">
      <li v-for="(r, i) in props.results" :key="i" class="border-b last:border-b-0 pb-2 last:pb-0">
        <a :href="r.url" target="_blank" class="font-medium hover:underline">{{ r.title }}</a>
        <div class="text-xs text-gray-500 mt-0.5" v-if="r.published_date">{{ r.published_date }}</div>
        <div class="text-sm mt-1 text-gray-700 dark:text-gray-300 line-clamp-3">{{ r.content }}</div>
      </li>
    </ul>
  </UCard>
</template>
