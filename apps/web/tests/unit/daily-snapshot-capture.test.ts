import { describe, expect, it, vi } from 'vitest'
import { captureDailySnapshot } from '../../composables/useDailySnapshotCapture'

function capture(netWorthSkipped: boolean, investments: { skipped: boolean } | null) {
  return { skipped: netWorthSkipped, investments }
}

describe('captureDailySnapshot', () => {
  it('posts an auto capture to the session route', async () => {
    const post = vi.fn().mockResolvedValue(capture(true, { skipped: true }))
    await captureDailySnapshot({ post, refresh: vi.fn() })
    expect(post).toHaveBeenCalledWith('/api/portfolio/capture-snapshot', { source: 'auto' })
  })

  it('refreshes performance when today\'s snapshot was newly recorded', async () => {
    const refresh = vi.fn()
    const post = vi.fn().mockResolvedValue(capture(false, { skipped: false }))
    await captureDailySnapshot({ post, refresh })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('skips the refresh when today\'s net-worth snapshot already existed', async () => {
    const refresh = vi.fn()
    // The performance card plots net worth only; a new investments row alone
    // does not change it.
    const post = vi.fn().mockResolvedValue(capture(true, { skipped: false }))
    await captureDailySnapshot({ post, refresh })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('swallows a failed capture so the page still loads', async () => {
    const refresh = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = vi.fn().mockRejectedValue(new Error('ghostfolio down'))
    await expect(captureDailySnapshot({ post, refresh })).resolves.toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
