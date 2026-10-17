import { evaluateAlert } from './alerts-core'
import { loadActiveAlerts, triggerAlert } from './alerts'
import type { AlertPosition, PriceAlertContext } from './price-alert-message'
import { sessionBars } from './price-chart'
import type { KLineResponse, Snapshot } from '../llm/http'

/** The parts of ApiClient this pass needs, plus an optional held-position lookup for the email. */
export interface QuoteSource {
  getSnapshot(args: { code: string }): Promise<Snapshot>
  getKline(args: { code: string; ktype: KLineResponse['ktype']; num: number }): Promise<KLineResponse>
  findPosition?(symbol: string): Promise<AlertPosition | null>
}

const ENRICH_TIMEOUT_MS = 8_000
const INTRADAY_BARS = 100
const DAILY_BARS = 252

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

function settled<T>(r: PromiseSettledResult<T>, what: string, symbol: string): T | null {
  if (r.status === 'fulfilled') return r.value
  console.warn('[alerts] email context:', what, 'unavailable for', symbol, r.reason instanceof Error ? r.reason.message : r.reason)
  return null
}

/**
 * Chart and position data for a triggering alert's email. Each piece is
 * fetched in parallel under its own timeout; a failure only nulls that piece.
 */
export async function gatherAlertContext(
  source: QuoteSource,
  symbol: string,
  quote: Snapshot,
  timeoutMs = ENRICH_TIMEOUT_MS,
): Promise<PriceAlertContext> {
  const [intraday, daily, position] = await Promise.allSettled([
    withTimeout(source.getKline({ code: symbol, ktype: '5m', num: INTRADAY_BARS }), timeoutMs).then(r => sessionBars(r.bars)),
    withTimeout(source.getKline({ code: symbol, ktype: '1d', num: DAILY_BARS }), timeoutMs).then(r => r.bars),
    source.findPosition ? withTimeout(source.findPosition(symbol), timeoutMs) : Promise.resolve(null),
  ])
  return {
    quote,
    intraday: settled(intraday, '5m bars', symbol),
    daily: settled(daily, 'daily bars', symbol),
    position: settled(position, 'position', symbol),
  }
}

/**
 * One pass of the price-alerts check (the `alerts:evaluate` task). Loads
 * active alerts, fetches one quote snapshot per distinct symbol from the
 * FastAPI quote service (sequentially — polite to OpenD), and triggers
 * alerts whose condition crossed. The decision is the pure evaluateAlert().
 *
 * A snapshot failure for one symbol skips only that symbol's alerts this
 * pass (never false-triggers); the next pass retries. A DB failure loading
 * alerts throws so the scheduler records it in the heartbeat. Email context
 * is gathered only for symbols with a crossed alert, and never blocks the
 * trigger.
 */
export async function runAlertEvaluation(
  client: QuoteSource,
  opts: { enrichTimeoutMs?: number } = {},
): Promise<{ checked: number; triggered: number }> {
  const alerts = await loadActiveAlerts()
  let triggered = 0
  const symbols = [...new Set(alerts.map(a => a.symbol))]
  for (const symbol of symbols) {
    let quote: Snapshot
    try {
      quote = await client.getSnapshot({ code: symbol })
    }
    catch (err) {
      console.error('[alerts] snapshot failed for', symbol, err instanceof Error ? err.message : err)
      continue
    }
    const crossed = alerts
      .filter(a => a.symbol === symbol)
      .flatMap(alert => {
        const result = evaluateAlert(alert, quote)
        return result ? [{ alert, price: result.price }] : []
      })
    if (crossed.length === 0) continue

    const context = await gatherAlertContext(client, symbol, quote, opts.enrichTimeoutMs)
      .catch((): PriceAlertContext => ({ quote, intraday: null, daily: null, position: null }))
    for (const { alert, price } of crossed) {
      try {
        if (await triggerAlert(alert.id, price, context)) triggered++
      }
      catch (err) {
        console.error('[alerts] failed to trigger alert', alert.id, err instanceof Error ? err.message : err)
      }
    }
  }
  return { checked: alerts.length, triggered }
}
