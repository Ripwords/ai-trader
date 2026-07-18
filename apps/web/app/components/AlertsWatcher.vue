<script setup lang="ts">
// Headless: mounts the global triggered-alerts poll loop so price-alert
// notifications fire on any page. Sibling of ActiveRunsWatcher; renders
// nothing.
import { useTriggeredAlerts } from '../../composables/useTriggeredAlerts'
useTriggeredAlerts()
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
