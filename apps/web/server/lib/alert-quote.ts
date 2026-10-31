import type { EvaluatableAlert } from './alerts-core'
import { getApiClient, type Snapshot } from '../llm/http'
import { getYahooQuote, type YahooQuote } from './yahoo'

export interface AlertQuoteDeps {
  snapshot: (code: string) => Promise<Snapshot>
  yahoo: (code: string) => Promise<YahooQuote | null>
}

const defaultDeps: AlertQuoteDeps = {
  snapshot: code => getApiClient().getSnapshot({ code }),
  yahoo: getYahooQuote,
}

/**
 * The quote an alert is checked against. OpenD refuses symbols outside the
 * account's markets (SGX, crypto, futures, BRK-B) and fails while it is down;
 * those alerts used to stay armed and never fire. Yahoo's delayed quote stands
 * in, with its missing fields as 0, which the evaluator and the email both
 * read as absent.
 */
export async function alertQuote(code: string, deps: AlertQuoteDeps = defaultDeps): Promise<Snapshot> {
  try {
    return await deps.snapshot(code)
  } catch (err) {
    const q = await deps.yahoo(code)
    if (!q) throw err
    return {
      code,
      name: q.name,
      lastPrice: q.lastPrice,
      openPrice: q.openPrice ?? 0,
      highPrice: q.highPrice ?? 0,
      lowPrice: q.lowPrice ?? 0,
      prevClosePrice: q.prevClosePrice ?? 0,
      changeRate: q.changeRate ?? 0,
      volume: q.volume ?? 0,
      turnover: 0,
      updateTime: q.updateTime ?? '',
    }
  }
}

const fmt = (n: number) => n.toFixed(2)

/**
 * Why a new alert is a mistake, or null. Alerts fire on the level, not on a
 * crossing, so one whose condition already holds fires within a minute and
 * says "crossed" when nothing moved: "notify me when NVDA hits 150" saved as
 * price_above with NVDA at 180.
 */
export function newAlertProblem(symbol: string, alert: EvaluatableAlert, quote: Snapshot): string | null {
  const { kind, threshold } = alert
  const last = quote.lastPrice
  if (kind === 'pct_move_day') {
    if (threshold >= 100) return `${threshold} is a percent for a day-move alert; did you mean a price alert (price_above / price_below)?`
    const prev = quote.prevClosePrice
    if (!(last > 0) || !(prev > 0)) return null
    const move = (last - prev) / prev * 100
    if (Math.abs(move) < threshold) return null
    return `${symbol} has already moved ${move >= 0 ? '+' : ''}${move.toFixed(1)}% this session, past ${threshold}%, so the alert would fire at once. Pick a larger move, or set it once the next session opens.`
  }
  if (!(last > 0)) return null
  if (kind === 'price_above' && last >= threshold) {
    return `${symbol} is already at ${fmt(last)}, at or above ${fmt(threshold)}, so the alert would fire at once. Use price_below to be told when it falls to ${fmt(threshold)}.`
  }
  if (kind === 'price_below' && last <= threshold) {
    return `${symbol} is already at ${fmt(last)}, at or below ${fmt(threshold)}, so the alert would fire at once. Use price_above to be told when it rises to ${fmt(threshold)}.`
  }
  return null
}

/**
 * The check both create paths (the alerts route and the alert_create tool)
 * run: a symbol with no price from either source could never fire, and one
 * whose condition already holds would fire at once.
 */
export async function checkNewAlert(symbol: string, alert: EvaluatableAlert, deps: AlertQuoteDeps = defaultDeps): Promise<string | null> {
  let quote: Snapshot
  try {
    quote = await alertQuote(symbol, deps)
  } catch {
    return `no price is available for ${symbol} from moomoo or Yahoo, so the alert could never fire`
  }
  return newAlertProblem(symbol, alert, quote)
}
