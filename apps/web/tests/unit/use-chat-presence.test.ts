// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'

const focused = ref(true)
const visibility = ref<DocumentVisibilityState>('visible')
vi.mock('@vueuse/core', async (orig) => {
  const actual = await orig<typeof import('@vueuse/core')>()
  return { ...actual, useWindowFocus: () => focused, useDocumentVisibility: () => visibility }
})

const { useChatPresence } = await import('../../app/composables/useChatPresence')

type Report = { threadId: string; clientId: string; away: boolean }
let posts: Report[]
let beacons: Report[]
let scope: EffectScope

beforeEach(() => {
  vi.useFakeTimers()
  focused.value = true
  visibility.value = 'visible'
  posts = []
  beacons = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    posts.push(JSON.parse(String(init.body)))
    return new Response('{}')
  }))
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: vi.fn((_url: string, body: string) => {
      beacons.push(JSON.parse(body))
      return true
    }),
  })
})

afterEach(() => {
  scope?.stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function start(thread: string | null) {
  const id = ref(thread)
  scope = effectScope()
  scope.run(() => useChatPresence(id))
  return id
}

describe('useChatPresence', () => {
  it('reports the open chat as in view at once', () => {
    start('th-1')
    expect(posts).toMatchObject([{ threadId: 'th-1', away: false }])
  })

  it('reports nothing before a chat exists', () => {
    start(null)
    expect(posts).toEqual([])
  })

  it('reports away on blur and on a hidden page, and back on return', async () => {
    start('th-1')
    focused.value = false
    await nextTick()
    focused.value = true
    await nextTick()
    visibility.value = 'hidden'
    await nextTick()
    expect(posts.map(p => p.away)).toEqual([false, true, false, true])
  })

  it('heartbeats every 30 s only while in view', async () => {
    start('th-1')
    vi.advanceTimersByTime(30_000)
    expect(posts.map(p => p.away)).toEqual([false, false])
    visibility.value = 'hidden'
    await nextTick()
    vi.advanceTimersByTime(90_000)
    expect(posts.map(p => p.away)).toEqual([false, false, true])
  })

  it('leaves the old chat and reports the new one when the chat changes', async () => {
    const id = start('th-1')
    id.value = 'th-2'
    await nextTick()
    expect(posts.slice(1)).toMatchObject([{ threadId: 'th-1', away: true }, { threadId: 'th-2', away: false }])
    id.value = null
    await nextTick()
    expect(posts.slice(3)).toMatchObject([{ threadId: 'th-2', away: true }])
  })

  it('sends a beacon saying away on pagehide', () => {
    start('th-1')
    window.dispatchEvent(new Event('pagehide'))
    expect(beacons).toMatchObject([{ threadId: 'th-1', away: true }])
  })

  it('uses one client id per tab', async () => {
    start('th-1')
    focused.value = false
    await nextTick()
    expect(new Set(posts.map(p => p.clientId)).size).toBe(1)
    expect(posts[0]!.clientId).toBeTruthy()
  })
})
