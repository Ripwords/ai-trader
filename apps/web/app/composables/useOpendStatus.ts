import { ref, watch, type Ref } from 'vue'
import { createSharedComposable, useDocumentVisibility, useIntervalFn } from '@vueuse/core'

export interface OpendStatus {
  reachable: boolean
  qot_logined: boolean
  trd_logined: boolean
  server_ver?: string
}

export const OPEND_POLL_MS = 60_000

const DOWN: OpendStatus = { reachable: false, qot_logined: false, trd_logined: false }

function _useOpendStatus(): { status: Ref<OpendStatus | null>, refresh: () => Promise<void> } {
  const status = ref<OpendStatus | null>(null)

  async function refresh(): Promise<void> {
    try {
      status.value = await $fetch<OpendStatus>('/api/opend-status')
    } catch {
      status.value = { ...DOWN }
    }
  }

  if (typeof window !== 'undefined') {
    const visibility = useDocumentVisibility()
    const { pause, resume } = useIntervalFn(() => { void refresh() }, OPEND_POLL_MS, { immediate: false })
    watch(visibility, (v) => {
      if (v === 'hidden') {
        pause()
        return
      }
      void refresh()
      resume()
    }, { immediate: true })
  }

  return { status, refresh }
}

/** OpenD reachability, polled once for every component that shows it, paused while the tab is hidden. */
export const useOpendStatus = createSharedComposable(_useOpendStatus)
