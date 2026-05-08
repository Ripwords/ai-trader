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

export interface Account {
  acc_id: number
  trd_env: 'SIMULATE' | 'REAL'
  acc_type: string
  card_num: string | null
  security_firm: string | null
  trdmarket_auth: string[]
  acc_role: string | null
}

export interface Position {
  code: string
  qty: number
  cost_price: number
  current_price: number
  market_val: number
  pl_val: number
  pl_ratio: number
}

export interface Portfolio {
  cash: number
  market_val: number
  total_assets: number
  positions: Position[]
}

export interface Order {
  order_id: string
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  status: string
  created_at: string
}

export interface Fill {
  fill_id: string
  order_id: string
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  fill_at: string
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

  async getOpendState(): Promise<{ reachable: boolean; qot_logined: boolean; trd_logined: boolean; server_ver?: string }> {
    return this.fetch('/quote/state')
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

  listAccounts(): Promise<Account[]> {
    return this.fetch('/trade/accounts')
  }

  getPortfolio(args: { acc_id: number; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Portfolio> {
    return this.fetch('/trade/portfolio', { query: args })
  }

  listOrders(args: { acc_id: number; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Order[]> {
    return this.fetch('/trade/orders', { query: args })
  }

  listFills(args: { acc_id: number; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Fill[]> {
    return this.fetch('/trade/fills', { query: args })
  }
}

export function getApiClient() {
  const cfg = useRuntimeConfig()
  return new ApiClient({ baseUrl: cfg.apiBaseUrl as string, bearer: cfg.internalBearer as string })
}
