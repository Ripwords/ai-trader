// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { OPEND_POLL_MS, useOpendStatus } from '../../app/composables/useOpendStatus'

const fetchSpy = vi.fn(async () => ({ reachable: true, qot_logined: true, trd_logined: false }))

const Probe = defineComponent({
  setup() {
    const { status } = useOpendStatus()
    return () => h('span', status.value?.reachable ? 'up' : 'unknown')
  },
})

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function flush(): Promise<void> {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

let wrappers: VueWrapper[] = []

beforeEach(() => {
  vi.useFakeTimers()
  fetchSpy.mockClear()
  vi.stubGlobal('$fetch', fetchSpy)
  setVisibility('visible')
})

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useOpendStatus', () => {
  it('shares one poll between the header and the sidebar', async () => {
    wrappers = [mount(Probe), mount(Probe)]
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/api/opend-status')
    expect(wrappers.map(w => w.text())).toEqual(['up', 'up'])
  })

  it('polls every 60 s, not every 6 s', async () => {
    expect(OPEND_POLL_MS).toBe(60_000)
    wrappers = [mount(Probe)]
    await flush()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(OPEND_POLL_MS)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('pauses while the tab is hidden and refreshes on return', async () => {
    wrappers = [mount(Probe)]
    await flush()
    setVisibility('hidden')
    await flush()
    await vi.advanceTimersByTimeAsync(OPEND_POLL_MS * 3)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('stops polling once every user unmounts', async () => {
    wrappers = [mount(Probe)]
    await flush()
    wrappers[0]!.unmount()
    wrappers = []
    await vi.advanceTimersByTimeAsync(OPEND_POLL_MS * 2)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('reports down when the status call fails', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('502'))
    const Down = defineComponent({
      setup() {
        const { status } = useOpendStatus()
        return () => h('span', JSON.stringify(status.value))
      },
    })
    wrappers = [mount(Down)]
    await flush()
    await flush()
    expect(JSON.parse(wrappers[0]!.text())).toEqual({ reachable: false, qot_logined: false, trd_logined: false })
  })
})
