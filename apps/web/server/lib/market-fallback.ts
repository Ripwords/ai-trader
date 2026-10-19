import type { ApiClient, Bar, KLineResponse, Snapshot } from '../llm/http'
import { getYahooBars, getYahooQuote, type YahooInterval, type YahooQuote } from './yahoo'

// moomoo refuses quotes for markets the account has no permission for (e.g.
// Bursa Malaysia) and fails outright while OpenD is down. The chart and quote
// tools then fall back to Yahoo's delayed data, marked so the model says so.

interface Fallback {
  source: 'yahoo'
  delayed: true
  /** The moomoo error that caused the fallback. */
  fallbackReason: string
}

export type YahooKLine = Omit<KLineResponse, 'bars'> & Fallback & { bars: Bar[] }
export type YahooSnapshot = YahooQuote & Fallback & { code: string; turnover: null }

// Yahoo has no intraday history worth charting against moomoo's, so only
// daily and longer candles fall back.
const YAHOO_INTERVAL: Partial<Record<KLineResponse['ktype'], YahooInterval>> = { '1d': '1d', '1w': '1wk', '1M': '1mo' }

function reasonOf(err: unknown): string {
  const detail = (err as { data?: { detail?: unknown } } | null)?.data?.detail
  if (typeof detail === 'string') return detail
  return err instanceof Error ? err.message : String(err)
}

export async function klineWithFallback(
  client: ApiClient,
  args: { code: string; ktype: KLineResponse['ktype']; num: number },
): Promise<KLineResponse | YahooKLine> {
  try {
    return await client.getKline(args)
  } catch (err) {
    const interval = YAHOO_INTERVAL[args.ktype]
    if (!interval) throw err
    const bars = await getYahooBars(args.code, interval, args.num)
    if (bars.length === 0) throw err
    return {
      code: args.code,
      ktype: args.ktype,
      bars: bars.map(b => ({ ...b, turnover: null })),
      source: 'yahoo',
      delayed: true,
      fallbackReason: reasonOf(err),
    }
  }
}

export async function snapshotWithFallback(
  client: ApiClient,
  args: { code: string },
): Promise<Snapshot | YahooSnapshot> {
  try {
    return await client.getSnapshot(args)
  } catch (err) {
    const quote = await getYahooQuote(args.code)
    if (!quote) throw err
    return { code: args.code, ...quote, turnover: null, source: 'yahoo', delayed: true, fallbackReason: reasonOf(err) }
  }
}
