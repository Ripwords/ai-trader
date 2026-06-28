<script setup lang="ts">
// Headless: mounts the global active-runs poll loop so research-run completion
// notifications fire on any page (chat included), regardless of where the run
// was started. Renders nothing.
import { useActiveRuns } from '../../composables/useActiveRuns'
useActiveRuns()
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
