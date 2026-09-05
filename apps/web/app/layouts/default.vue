<script setup lang="ts">
// Shared shell — global header + mobile drawer wrap every page.
// Pages opt into a chat-side rail by teleporting into #shell-drawer-extra.
const drawerOpen = useState('shell.drawerOpen', () => false)
</script>

<template>
  <div class="app-shell">
    <AppShellHeader
      :drawer-open="drawerOpen"
      @toggle-drawer="drawerOpen = !drawerOpen"
    />
    <ActiveRunsWatcher />
    <AlertsWatcher />

    <div class="app-body">
      <slot />
    </div>

    <AppShellDrawer v-model:open="drawerOpen">
      <template #extra>
        <!-- Pages teleport supplemental drawer content here. -->
        <div id="shell-drawer-extra" class="contents" />
      </template>
    </AppShellDrawer>
  </div>
</template>

<style scoped>
.app-shell {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--ink-0);
  color: var(--paper-0);
  overflow: hidden;
  /* Landscape notch. Vertical insets are applied by the header and the chat
     footer themselves, since those are the elements that touch the edges. */
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
</style>
