import { defineNitroPlugin } from 'nitropack/runtime'
import { getApiClient } from '../llm/http'
import { evaluateAlert } from '../lib/alerts-core'
import { loadActiveAlerts, markAlertTriggered } from '../lib/alerts'
import { createGuardedTick } from '../lib/guarded-tick'

/**
 * Price-alerts evaluation loop. Every PRICE_ALERTS_INTERVAL_MS (default 60s)
 * it loads active alerts, fetches one quote snapshot per distinct symbol
 * from the FastAPI quote service (sequentially — polite to OpenD), and flips
 * alerts whose condition crossed to status='triggered'.
 *
 * The decision itself is the pure evaluateAlert() in server/lib/alerts-core.ts
 * (unit-tested); this plugin is only the timer + IO around it.
 *
 * Env guards (same opt-out pattern as e2e-stub-agents.ts):
 *   - PRICE_ALERTS_DISABLED=1     -> loop never starts (tests, one-off scripts)
 *   - PRICE_ALERTS_INTERVAL_MS=n  -> override the 60s cadence
 *
 * Failure posture: a snapshot failure for one symbol skips only that
 * symbol's alerts for this tick (never false-triggers, never kills the
 * loop); the next tick retries.
 */
const DEFAULT_INTERVAL_MS = 60_000

export default defineNitroPlugin(() => {
  if (process.env.PRICE_ALERTS_DISABLED === '1') return

  const parsed = Number(process.env.PRICE_ALERTS_INTERVAL_MS)
  const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS

  async function evaluate() {
    try {
      const alerts = await loadActiveAlerts()
      if (alerts.length === 0) return

      const client = getApiClient()
      const symbols = [...new Set(alerts.map(a => a.symbol))]
      for (const symbol of symbols) {
        let quote: { lastPrice: number; prevClosePrice: number }
        try {
          quote = await client.getSnapshot({ code: symbol })
        } catch (err) {
          // Quote unavailable — skip this symbol's alerts, keep the loop alive.
          console.error('[alerts] snapshot failed for', symbol, err)
          continue
        }
        for (const alert of alerts.filter(a => a.symbol === symbol)) {
          const result = evaluateAlert(alert, quote)
          if (!result) continue
          try {
            await markAlertTriggered(alert.id, result.price)
          } catch (err) {
            console.error('[alerts] failed to mark alert triggered', alert.id, err)
          }
        }
      }
    } catch (err) {
      // DB down etc — log and let the next tick retry.
      console.error('[alerts] evaluation tick failed', err)
    }
  }

  // Each snapshot already times out; this bounds the whole tick (DB included)
  // so one stuck await can't stop alert checks until a restart.
  const tick = createGuardedTick(evaluate, intervalMs * 5, () => {
    console.error('[alerts] evaluation tick timed out; starting fresh next interval')
  })

  const timer = setInterval(() => { void tick() }, intervalMs)
  // Don't let the poll loop keep a short-lived process (prerender, scripts) alive.
  if (typeof timer.unref === 'function') timer.unref()
})
