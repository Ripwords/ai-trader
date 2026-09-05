export interface ResearchRunSignal {
  id: string
  symbol: string
  status: string
  startedAt: string | Date
  finishedAt: string | Date | null
  rating: string | null
  confidence: number | string | null
  alpha: number | string | null
  outcome: string | null
  costUsd: number | string | null
}

export type ResearchQueueAction = 'monitor_running' | 'rerun_failed' | 'review_thesis' | 'refresh_stale' | 'none'
export type ResearchQueueSeverity = 'high' | 'medium' | 'low'

export interface ResearchQueueItem {
  symbol: string
  action: ResearchQueueAction
  severity: ResearchQueueSeverity
  note: string
  latest_run_id: string
  latest_started_at: string
  latest_rating: string | null
  latest_confidence: number | null
  days_since_complete: number | null
}

export interface ResearchIntelligence {
  summary: {
    total_symbols: number
    running_symbols: number
    stale_symbols: number
    failed_runs_7d: number
    avg_confidence: number | null
    total_cost_30d: number
  }
  queue: ResearchQueueItem[]
}

const STALE_DAYS = 21

function toTime(value: string | Date | null): number | null {
  if (!value) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString()
}

function toNumber(value: number | string | null): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function buildResearchIntelligence(rows: ResearchRunSignal[], now = new Date()): ResearchIntelligence {
  const nowMs = now.getTime()
  const sevenDaysAgo = nowMs - 7 * 24 * 60 * 60 * 1000
  const thirtyDaysAgo = nowMs - 30 * 24 * 60 * 60 * 1000
  const bySymbol = new Map<string, ResearchRunSignal[]>()

  for (const row of rows) {
    const symbol = row.symbol.trim().toUpperCase()
    if (!symbol) continue
    const list = bySymbol.get(symbol) ?? []
    list.push({ ...row, symbol })
    bySymbol.set(symbol, list)
  }

  const queue: ResearchQueueItem[] = []
  const confidences: number[] = []
  let runningSymbols = 0
  let staleSymbols = 0
  let failedRuns7d = 0
  let totalCost30d = 0

  for (const [symbol, symbolRows] of bySymbol.entries()) {
    const sorted = [...symbolRows].sort((a, b) => (toTime(b.startedAt) ?? 0) - (toTime(a.startedAt) ?? 0))
    const latest = sorted[0]!
    const latestStarted = toTime(latest.startedAt) ?? nowMs
    const completeRows = sorted.filter(row => row.status === 'complete')
    const latestComplete = completeRows[0] ?? null
    const confidence = toNumber(latestComplete?.confidence ?? latest.confidence)
    if (confidence !== null) confidences.push(confidence)

    const latestCompleteTime = latestComplete ? toTime(latestComplete.startedAt) : null
    const daysSinceComplete = latestCompleteTime === null
      ? null
      : Math.floor((nowMs - latestCompleteTime) / (24 * 60 * 60 * 1000))
    const alpha = toNumber(latestComplete?.alpha ?? latest.alpha)
    const outcome = latestComplete?.outcome ?? latest.outcome
    const failedRecent = sorted.some(row => row.status === 'failed' && (toTime(row.startedAt) ?? 0) >= sevenDaysAgo)
    const isRunning = sorted.some(row => row.status === 'running')
    const isStale = daysSinceComplete !== null && daysSinceComplete > STALE_DAYS
    // alpha is stored in percentage points (reflection.py multiplies by 100).
    const weakReflection = outcome === 'wrong' || (alpha !== null && alpha < -2)

    for (const row of sorted) {
      const started = toTime(row.startedAt) ?? 0
      const cost = toNumber(row.costUsd) ?? 0
      if (started >= thirtyDaysAgo) totalCost30d += cost
      if (row.status === 'failed' && started >= sevenDaysAgo) failedRuns7d += 1
    }

    let action: ResearchQueueAction = 'none'
    let severity: ResearchQueueSeverity = 'low'
    let note = 'Thesis is current.'
    if (isRunning) {
      action = 'monitor_running'
      severity = 'high'
      note = 'Agent run is in flight.'
      runningSymbols += 1
    } else if (failedRecent || completeRows.length === 0) {
      action = 'rerun_failed'
      severity = 'high'
      note = completeRows.length === 0 ? 'No completed agent verdict yet.' : 'Recent run failed; rerun before relying on the thesis.'
    } else if (weakReflection) {
      action = 'review_thesis'
      severity = 'medium'
      note = alpha !== null ? `Latest reflection alpha is ${round(alpha, 2)}%.` : 'Latest reflection marked the call wrong.'
    } else if (isStale) {
      action = 'refresh_stale'
      severity = 'medium'
      note = `Latest complete thesis is ${daysSinceComplete} days old.`
      staleSymbols += 1
    }
    if (isStale && action !== 'refresh_stale') staleSymbols += 1

    queue.push({
      symbol,
      action,
      severity,
      note,
      latest_run_id: latest.id,
      latest_started_at: toIso(latest.startedAt),
      latest_rating: latestComplete?.rating ?? latest.rating,
      latest_confidence: confidence,
      days_since_complete: daysSinceComplete,
    })
  }

  const severityWeight: Record<ResearchQueueSeverity, number> = { high: 2, medium: 1, low: 0 }
  return {
    summary: {
      total_symbols: bySymbol.size,
      running_symbols: runningSymbols,
      stale_symbols: staleSymbols,
      failed_runs_7d: failedRuns7d,
      avg_confidence: confidences.length > 0
        ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
        : null,
      total_cost_30d: round(totalCost30d, 2),
    },
    queue: queue
      .filter(item => item.action !== 'none')
      .sort((a, b) => {
        const severityDiff = severityWeight[b.severity] - severityWeight[a.severity]
        if (severityDiff !== 0) return severityDiff
        return new Date(b.latest_started_at).getTime() - new Date(a.latest_started_at).getTime()
      }),
  }
}
