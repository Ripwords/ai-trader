import { computed, watch, type Ref } from 'vue'
import { useDocumentVisibility, useEventListener, useIntervalFn, useWindowFocus } from '@vueuse/core'
import { generateId } from 'ai'

const ENDPOINT = '/api/chat/presence'
/** Half the server's 60 s freshness window, so one late beat doesn't read as gone. */
const HEARTBEAT_MS = 30_000

/**
 * Tells the server whether this tab is looking at `threadId`, so a reply
 * that finishes while you're away pushes a notification. Focus alone misses
 * a backgrounded mobile tab or PWA, which doesn't reliably blur, hence the
 * visibility check too.
 */
export function useChatPresence(threadId: Ref<string | null>): void {
  if (typeof window === 'undefined') return
  const focused = useWindowFocus()
  const visibility = useDocumentVisibility()
  const away = computed(() => !focused.value || visibility.value !== 'visible')
  const clientId = generateId()

  const send = (id: string, isAway: boolean) => {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: id, clientId, away: isAway }),
      keepalive: true,
    }).catch(() => {})
  }

  watch([threadId, away], ([id, isAway], previous) => {
    const prevId = previous?.[0]
    if (prevId && prevId !== id) send(prevId, true)
    if (id) send(id, isAway)
  }, { immediate: true })

  useIntervalFn(() => {
    if (threadId.value && !away.value) send(threadId.value, false)
  }, HEARTBEAT_MS)

  // A page being closed can't finish a fetch reliably; a beacon can. It goes as text/plain.
  useEventListener(window, 'pagehide', () => {
    if (threadId.value) navigator.sendBeacon(ENDPOINT, JSON.stringify({ threadId: threadId.value, clientId, away: true }))
  })
}
