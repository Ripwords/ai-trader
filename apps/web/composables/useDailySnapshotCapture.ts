interface AutoCaptureResponse {
  skipped: boolean
}

export interface DailySnapshotDeps {
  post: (url: string, body: { source: 'auto' }) => Promise<AutoCaptureResponse>
  refresh: () => unknown
}

/**
 * Take today's auto portfolio snapshot (a no-op after the first one of the
 * UTC day) and refresh the equity curve when a new net-worth point landed.
 * Failures only warn: a missed snapshot must not break the page, and the
 * next page load retries.
 */
export async function captureDailySnapshot({ post, refresh }: DailySnapshotDeps): Promise<void> {
  try {
    const result = await post('/api/portfolio/capture-snapshot', { source: 'auto' })
    if (!result.skipped) await refresh()
  } catch (err) {
    console.warn('[portfolio] daily snapshot capture failed:', err instanceof Error ? err.message : err)
  }
}
