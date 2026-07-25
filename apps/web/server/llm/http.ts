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

export interface OrderBookLevel {
  price: number
  volume: number
  order_count: number
  details: Record<string, unknown>
}

export interface OrderBook {
  code: string
  name: string | null
  bid_time: string | null
  ask_time: string | null
  bids: OrderBookLevel[]
  asks: OrderBookLevel[]
}

export interface WatchlistItem {
  code: string
  name: string | null
  group: string
}

export interface Account {
  acc_id: string
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
  // Settlement currency (e.g. 'USD', 'HKD'). null when the broker didn't
  // report it — never assume USD.
  currency: string | null
}

export interface Portfolio {
  cash: number
  market_val: number
  total_assets: number
  positions: Position[]
  // REPORTING currency of the scalars, set by the server's
  // MOOMOO_REPORT_CURRENCY — not a broker fact (moomoo exposes no per-account
  // base currency and converts into whatever we request). The scalar `cash` is
  // every currency's cash converted into it — NOT a native balance. Don't
  // present it as money the user holds; use cash_by_currency.
  currency: string | null
  // Native cash actually held, keyed by real currency (e.g. { USD: 1634.12 }).
  // Prefer this over cash/currency when reporting what the user owns.
  cash_by_currency: Record<string, number>
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

  post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.fetch<T>(path, { method: 'POST', body })
  }

  get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.fetch<T>(path, { query })
  }

  async getKline(args: { code: string; ktype: KLineResponse['ktype']; num: number }): Promise<KLineResponse> {
    return this.fetch('/quote/kline', { query: args })
  }

  async getSnapshot(args: { code: string }): Promise<Snapshot> {
    const raw = await this.fetch<Record<string, unknown>>('/quote/snapshot', { query: args })
    return snakeToCamel(raw) as unknown as Snapshot
  }

  async getOrderBook(args: { code: string; num?: number }): Promise<OrderBook> {
    return this.fetch('/quote/order-book', { query: args })
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

  getPortfolio(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Portfolio> {
    return this.fetch('/trade/portfolio', { query: args })
  }

  listOrders(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Order[]> {
    return this.fetch('/trade/orders', { query: args })
  }

  listFills(args: { acc_id: string; trd_env?: 'SIMULATE' | 'REAL' }): Promise<Fill[]> {
    return this.fetch('/trade/fills', { query: args })
  }

  listHistoryOrders(args: {
    acc_id: string
    trd_env?: 'SIMULATE' | 'REAL'
    start?: string
    end?: string
    code?: string
  }): Promise<Order[]> {
    return this.fetch('/trade/orders/history', { query: args })
  }

  listHistoryFills(args: {
    acc_id: string
    trd_env?: 'SIMULATE' | 'REAL'
    start?: string
    end?: string
    code?: string
  }): Promise<Fill[]> {
    return this.fetch('/trade/fills/history', { query: args })
  }

  placeOrder(args: {
    code: string
    side: 'BUY' | 'SELL'
    qty: number
    price?: number
    order_type?: 'NORMAL' | 'MARKET' | 'STOP' | 'STOP_LIMIT'
    trigger_price?: number
    trd_env?: 'SIMULATE' | 'REAL'
    acc_id?: string
  }): Promise<PlaceOrderResult> {
    return this.fetch('/trade/order/place', { method: 'POST', body: args })
  }

  modifyOrder(args: {
    order_id: string
    acc_id: string
    price?: number
    qty?: number
    trigger_price?: number
    trd_env?: 'SIMULATE' | 'REAL'
  }): Promise<{ order_id: string; status: string }> {
    return this.fetch('/trade/order/modify', { method: 'POST', body: args })
  }

  cancelOrder(args: {
    order_id: string
    acc_id: string
    trd_env?: 'SIMULATE' | 'REAL'
  }): Promise<{ order_id: string; status: string }> {
    return this.fetch('/trade/order/cancel', { method: 'POST', body: args })
  }

  valuationScreen(args: { symbols?: string[] } = {}): Promise<ValuationScreenResponse> {
    const query = args.symbols?.length ? { symbols: args.symbols.join(',') } : undefined
    return this.fetch('/valuation/screen', { query })
  }
}

// Decimal fields cross the wire as strings (pydantic v2 JSON serialization).
export interface ValuationScreenRow {
  symbol: string
  fair_value: string | null
  current_price: string | null
  margin_of_safety_pct: string | null
  data_quality: 'full' | 'multiples_only' | 'unavailable' | null
  veto: boolean | null
  error: string | null
}

export interface ValuationScreenResponse {
  rows: ValuationScreenRow[]
  total_symbols: number
  truncated: boolean
  source: 'watchlist' | 'symbols'
  warnings: string[]
}

export interface PlaceOrderResult {
  order_id: string
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  status: string
  trd_env: 'SIMULATE' | 'REAL'
  acc_id: string
}

// --- Algo --------------------------------------------------------------

export type AlgoCadence = '1m' | '5m' | '15m' | '1h' | '1d'

export type AlgoSizingMode = 'fixed_qty' | 'pct_equity' | 'fixed_cash'

export interface AlgoStrategy {
  id: string
  name: string
  symbol: string
  cadence: AlgoCadence
  code: string
  enabled: boolean
  initial_capital: number
  commission_bps: number
  slippage_bps: number
  sizing_mode: AlgoSizingMode
  sizing_value: number
  pyramiding_max: number
  created_at: string
  updated_at: string
}

export interface AlgoStrategyCreate {
  name: string
  symbol: string
  cadence: AlgoCadence
  code: string
  initial_capital?: number
  commission_bps?: number
  slippage_bps?: number
  sizing_mode?: AlgoSizingMode
  sizing_value?: number
  pyramiding_max?: number
}

export interface AlgoStrategyUpdate {
  name?: string
  symbol?: string
  cadence?: AlgoCadence
  code?: string
  enabled?: boolean
  initial_capital?: number
  commission_bps?: number
  slippage_bps?: number
  sizing_mode?: AlgoSizingMode
  sizing_value?: number
  pyramiding_max?: number
}

export interface AlgoEquityPoint { t: string, v: number }

export interface AlgoTrade {
  ts: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  pnl: number
}

export interface AlgoMetrics {
  pnl: number
  win_rate: number
  max_dd: number
  sharpe: number
  fills: number
  round_trips: number
  wins: number
  losses: number
  benchmark_pnl: number
}

export interface AlgoBacktestResult {
  run_id: string
  status: 'pending' | 'running' | 'ok' | 'error'
  equity_curve: AlgoEquityPoint[]
  benchmark_curve: AlgoEquityPoint[]
  price_bars: Bar[]
  trades: AlgoTrade[]
  metrics: AlgoMetrics | null
  error: string | null
}

export interface AlgoSignal {
  id: number
  strategy_id: string
  ts: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number | null
  order_id: string | null
  error: string | null
}

export interface AlgoState {
  kill_active: boolean
  enabled_strategies: string[]
}

declare module './http' {} // keep TS happy when this file is imported as a side-effect

export interface AlgoValidateResult {
  ok: boolean
  error: string | null
}

export interface AlgoApi {
  listStrategies(): Promise<AlgoStrategy[]>
  createStrategy(body: AlgoStrategyCreate): Promise<AlgoStrategy>
  getStrategy(id: string): Promise<AlgoStrategy>
  updateStrategy(id: string, body: AlgoStrategyUpdate): Promise<AlgoStrategy>
  deleteStrategy(id: string): Promise<void>
  backtest(id: string, body: { bars: number }): Promise<AlgoBacktestResult>
  getRun(runId: string): Promise<AlgoBacktestResult>
  validateCode(body: { code: string }): Promise<AlgoValidateResult>
  listSignals(args?: { strategy_id?: string; limit?: number }): Promise<AlgoSignal[]>
  state(): Promise<AlgoState>
  kill(): Promise<AlgoState>
  unkill(): Promise<AlgoState>
}

export function getAlgoApi(): AlgoApi {
  const cfg = useRuntimeConfig()
  const fetch = ofetch.create({
    baseURL: cfg.apiBaseUrl as string,
    headers: { Authorization: `Bearer ${cfg.internalBearer as string}` },
  })
  return {
    listStrategies: () => fetch('/algo/strategies'),
    createStrategy: (body) => fetch('/algo/strategies', { method: 'POST', body }),
    getStrategy: (id) => fetch(`/algo/strategies/${id}`),
    updateStrategy: (id, body) => fetch(`/algo/strategies/${id}`, { method: 'PUT', body }),
    deleteStrategy: async (id) => { await fetch(`/algo/strategies/${id}`, { method: 'DELETE' }) },
    backtest: (id, body) => fetch(`/algo/strategies/${id}/backtest`, { method: 'POST', body }),
    getRun: (runId) => fetch(`/algo/runs/${runId}`),
    validateCode: (body) => fetch('/algo/validate', { method: 'POST', body }),
    listSignals: (args = {}) => fetch('/algo/signals', { query: args }),
    state: () => fetch('/algo/state'),
    kill: () => fetch('/algo/kill', { method: 'POST' }),
    unkill: () => fetch('/algo/unkill', { method: 'POST' }),
  }
}

export function getApiClient() {
  const cfg = useRuntimeConfig()
  return new ApiClient({ baseUrl: cfg.apiBaseUrl as string, bearer: cfg.internalBearer as string })
}
