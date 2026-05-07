import { ofetch } from 'ofetch'

export interface ApiClientOptions {
  baseUrl: string
  bearer: string
}

export interface Bar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  turnover: number
}

export interface KLineResponse {
  code: string
  ktype: '1m' | '3m' | '5m' | '15m' | '30m' | '60m' | '1d' | '1w' | '1M'
  bars: Bar[]
}

export interface Snapshot {
  code: string
  name: string | null
  lastPrice: number
  openPrice: number
  highPrice: number
  lowPrice: number
  prevClosePrice: number
  changeRate: number
  volume: number
  turnover: number
  updateTime: string
}

export interface WatchlistItem {
  code: string
  name: string | null
  group: string
}

function snakeToCamel<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())
    out[camel] = v
  }
  return out
}

export class ApiClient {
  private fetch: typeof ofetch
  constructor(opts: ApiClientOptions) {
    this.fetch = ofetch.create({
      baseURL: opts.baseUrl,
      headers: { Authorization: `Bearer ${opts.bearer}` },
    })
  }

  async getKline(args: { code: string; ktype: KLineResponse['ktype']; num: number }): Promise<KLineResponse> {
    return this.fetch('/quote/kline', { query: args })
  }

  async getSnapshot(args: { code: string }): Promise<Snapshot> {
    const raw = await this.fetch<Record<string, unknown>>('/quote/snapshot', { query: args })
    return snakeToCamel(raw) as unknown as Snapshot
  }

  async listWatchlist(args: { group?: string } = {}): Promise<WatchlistItem[]> {
    return this.fetch('/watchlist/list', { query: args })
  }

  async addWatchlistItem(args: { code: string; group?: string }): Promise<{ status: string }> {
    return this.fetch('/watchlist/add', { method: 'POST', body: args })
  }

  async removeWatchlistItem(args: { code: string; group?: string }): Promise<{ status: string }> {
    return this.fetch('/watchlist/remove', { method: 'POST', body: args })
  }
}

export function getApiClient() {
  const cfg = useRuntimeConfig()
  return new ApiClient({ baseUrl: cfg.apiBaseUrl as string, bearer: cfg.internalBearer as string })
}
