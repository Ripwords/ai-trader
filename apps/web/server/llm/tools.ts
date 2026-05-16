import { tool } from 'ai'
import { getCookie, type H3Event } from 'h3'
import { z } from 'zod'
import type { ApiClient } from './http'
import { searchWithFallback } from '../lib/search'

interface MakeToolsOptions {
  event?: H3Event
  latestUserText?: string
}

type MakeToolsArg = H3Event | MakeToolsOptions | undefined

function isMakeToolsOptions(arg: MakeToolsArg): arg is MakeToolsOptions {
  return !!arg && ('latestUserText' in arg || 'event' in arg)
}

function normalizeOptions(arg: MakeToolsArg): MakeToolsOptions {
  if (!arg) return {}
  if (isMakeToolsOptions(arg)) return arg
  return { event: arg }
}

function normalizeConfirmationText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase()
}

function formatLiveNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

export function expectedLivePlaceConfirmation(args: {
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price?: number
  order_type?: 'NORMAL' | 'MARKET'
}): string {
  const orderType = args.order_type ?? 'NORMAL'
  const pricePart = args.price != null ? ` @ ${formatLiveNumber(args.price)}` : ''
  return `LIVE PLACE ${args.side} ${args.qty} ${args.code} ${orderType}${pricePart}`.toUpperCase()
}

export function expectedLiveModifyConfirmation(args: {
  order_id: string
  price?: number
  qty?: number
}): string {
  const pricePart = args.price != null ? ` PRICE ${formatLiveNumber(args.price)}` : ''
  const qtyPart = args.qty != null ? ` QTY ${args.qty}` : ''
  return `LIVE MODIFY ${args.order_id}${pricePart}${qtyPart}`.toUpperCase()
}

export function expectedLiveCancelConfirmation(args: { order_id: string }): string {
  return `LIVE CANCEL ${args.order_id}`.toUpperCase()
}

function assertLiveTradeConfirmed(args: {
  trd_env?: 'SIMULATE' | 'REAL'
  expected: string
  provided?: string
  latestUserText?: string
}) {
  if (args.trd_env !== 'REAL') return

  const expected = normalizeConfirmationText(args.expected)
  const provided = normalizeConfirmationText(args.provided)
  const latestUserText = normalizeConfirmationText(args.latestUserText)
  if (provided !== expected || !latestUserText.includes(expected)) {
    throw new Error(
      `Live trade blocked. Ask the user to type this exact confirmation in their next message: ${expected}`,
    )
  }
}

/**
 * Tool catalogue for the trading copilot. All tools are simple
 * Vercel AI SDK `tool()` definitions — no abstraction layer.
 *
 * The `id` of each (the key in the returned record) is what the agent
 * sees as the tool name. Use kebab-or-dotted names; the chat UI renders
 * them in the UChatTool indicator.
 */
export function makeTools(client: ApiClient, arg?: MakeToolsArg) {
  const options = normalizeOptions(arg)
  return {
    'market_kline': tool({
      description:
        'Fetch candlestick (k-line) bars for a symbol. Use when the user asks for a chart, trend, or historical price.',
      inputSchema: z.object({
        code: z.string().describe('moomoo symbol like US.NVDA, HK.00700, SH.600519'),
        ktype: z
          .enum(['1m', '3m', '5m', '15m', '30m', '60m', '1d', '1w', '1M'])
          .default('1d')
          .describe('candle interval'),
        num: z.number().int().min(1).max(1000).default(60).describe('how many bars'),
      }),
      execute: async ({ code, ktype, num }) => client.getKline({ code, ktype, num }),
    }),

    'market_snapshot': tool({
      description:
        'Fetch the latest quote snapshot for a symbol (last price, change, volume, etc.).',
      inputSchema: z.object({ code: z.string() }),
      execute: async ({ code }) => client.getSnapshot({ code }),
    }),

    'market_order_book': tool({
      description:
        'Fetch current bid/ask order-book depth for a symbol. Read-only. Use when the user asks about liquidity, spread, depth, or best bid/ask. The server performs the required temporary moomoo ORDER_BOOK subscription for this read.',
      inputSchema: z.object({
        code: z.string().describe('moomoo symbol like US.NVDA, HK.00700'),
        num: z.number().int().min(1).max(50).default(10).describe('depth levels per side'),
      }),
      execute: async ({ code, num }) => client.getOrderBook({ code, num }),
    }),

    'watchlist_list': tool({
      description: 'List the user\'s moomoo watchlist symbols.',
      inputSchema: z.object({ group: z.string().default('All') }),
      execute: async ({ group }) => ({ items: await client.listWatchlist({ group }) }),
    }),

    'watchlist_add': tool({
      description: 'Add a symbol to the user\'s watchlist.',
      inputSchema: z.object({
        code: z.string().describe('e.g. US.NVDA'),
        group: z.string().default('All'),
      }),
      execute: async (args) => client.addWatchlistItem(args),
    }),

    'watchlist_remove': tool({
      description: 'Remove a symbol from the user\'s watchlist.',
      inputSchema: z.object({
        code: z.string(),
        group: z.string().default('All'),
      }),
      execute: async (args) => client.removeWatchlistItem(args),
    }),

    'search_web': tool({
      description:
        'Search the open web for general information (facts, definitions, recent context). Not market data.',
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(20).default(5),
      }),
      execute: async ({ query, maxResults }) => ({ results: await searchWithFallback('web', query, maxResults) }),
    }),

    'search_news': tool({
      description: 'Search recent news (headlines, market events) for a company or topic.',
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(20).default(5),
      }),
      execute: async ({ query, maxResults }) => ({ results: await searchWithFallback('news', query, maxResults) }),
    }),

    'trade_accounts': tool({
      description: 'List the user\'s moomoo accounts (paper + live).',
      inputSchema: z.object({}),
      execute: async () => ({ accounts: await client.listAccounts() }),
    }),

    'trade_account_overview': tool({
      description:
        'Read-only account overview for moomoo accounts in one environment. Filters IPO-only accounts by default, fetches portfolio totals for each usable account, and aggregates cash, market value, and total assets. Use before sizing trades or when the user asks for account-level buying power/exposure.',
      inputSchema: z.object({
        trd_env: z.enum(['SIMULATE', 'REAL']).default('REAL'),
        include_ipo: z.boolean().default(false),
      }),
      execute: async ({ trd_env, include_ipo }) => {
        const accounts = await client.listAccounts()
        const usable = accounts.filter(account => account.trd_env === trd_env && (include_ipo || account.acc_role !== 'IPO'))
        const skipped = accounts
          .filter(account => account.trd_env === trd_env && !include_ipo && account.acc_role === 'IPO')
          .map(account => ({ acc_id: String(account.acc_id), reason: 'IPO account' }))
        const rows = []
        for (const account of usable) {
          const portfolio = await client.getPortfolio({ acc_id: String(account.acc_id), trd_env })
          rows.push({ account, portfolio })
        }
        const totals = rows.reduce(
          (sum, row) => ({
            cash: sum.cash + row.portfolio.cash,
            market_val: sum.market_val + row.portfolio.market_val,
            total_assets: sum.total_assets + row.portfolio.total_assets,
          }),
          { cash: 0, market_val: 0, total_assets: 0 },
        )
        return { trd_env, totals, accounts: rows, skipped }
      },
    }),

    'trade_portfolio': tool({
      description: 'Get positions and cash for an account. Read-only. Defaults to REAL.',
      inputSchema: z.object({
        acc_id: z.string(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('REAL'),
      }),
      execute: async (args) => client.getPortfolio(args),
    }),

    'trade_orders': tool({
      description:
        'List today\'s orders for an account. Defaults to REAL. ' +
        'Skip accounts where acc_role is "IPO" — moomoo refuses this call on IPO accounts ' +
        '(422 with "does not support" message); pick a NORMAL acc_id from trade_accounts instead.',
      inputSchema: z.object({
        acc_id: z.string(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('REAL'),
      }),
      execute: async (args) => ({ orders: await client.listOrders(args) }),
    }),

    'trade_fills': tool({
      description:
        'List today\'s fills (executed trades) for an account. Defaults to REAL. ' +
        'Skip accounts where acc_role is "IPO" — moomoo refuses this call on IPO accounts ' +
        '(422 with "does not support" message); pick a NORMAL acc_id from trade_accounts instead.',
      inputSchema: z.object({
        acc_id: z.string(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('REAL'),
      }),
      execute: async (args) => ({ fills: await client.listFills(args) }),
    }),

    'trade_place_order': tool({
      description:
        'Place a paper trading order (default trd_env=SIMULATE). REFUSE to place live orders ' +
        '(trd_env=REAL) unless the latest user message includes the exact LIVE PLACE confirmation phrase. For NORMAL (limit) orders ' +
        'price is required; for MARKET orders price is ignored. acc_id is optional for paper — server ' +
        'auto-picks the first SIMULATE account if omitted.',
      inputSchema: z.object({
        code: z.string().describe('moomoo symbol like US.NVDA, HK.00700'),
        side: z.enum(['BUY', 'SELL']),
        qty: z.number().int().min(1),
        price: z.number().optional(),
        order_type: z.enum(['NORMAL', 'MARKET']).default('NORMAL'),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
        acc_id: z.string().optional(),
        live_confirmation: z.string().optional().describe('Required only for REAL orders. Must exactly match the LIVE PLACE phrase typed by the user in the latest message.'),
      }),
      execute: async (args) => {
        const { live_confirmation, ...order } = args
        assertLiveTradeConfirmed({
          trd_env: order.trd_env,
          expected: expectedLivePlaceConfirmation(order),
          provided: live_confirmation,
          latestUserText: options.latestUserText,
        })
        return client.placeOrder(order)
      },
    }),

    'trade_modify_order': tool({
      description:
        'Modify an existing order\'s price and/or quantity. acc_id required. trd_env defaults to SIMULATE. REAL modifies require an exact LIVE MODIFY confirmation phrase in the latest user message.',
      inputSchema: z.object({
        order_id: z.string(),
        acc_id: z.string(),
        price: z.number().optional(),
        qty: z.number().int().optional(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
        live_confirmation: z.string().optional().describe('Required only for REAL order modifies. Must exactly match the LIVE MODIFY phrase typed by the user in the latest message.'),
      }),
      execute: async (args) => {
        const { live_confirmation, ...modify } = args
        assertLiveTradeConfirmed({
          trd_env: modify.trd_env,
          expected: expectedLiveModifyConfirmation(modify),
          provided: live_confirmation,
          latestUserText: options.latestUserText,
        })
        return client.modifyOrder(modify)
      },
    }),

    'trade_cancel_order': tool({
      description: 'Cancel an existing order by order_id. acc_id required. REAL cancels require an exact LIVE CANCEL confirmation phrase in the latest user message.',
      inputSchema: z.object({
        order_id: z.string(),
        acc_id: z.string(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
        live_confirmation: z.string().optional().describe('Required only for REAL order cancels. Must exactly match the LIVE CANCEL phrase typed by the user in the latest message.'),
      }),
      execute: async (args) => {
        const { live_confirmation, ...cancel } = args
        assertLiveTradeConfirmed({
          trd_env: cancel.trd_env,
          expected: expectedLiveCancelConfirmation(cancel),
          provided: live_confirmation,
          latestUserText: options.latestUserText,
        })
        return client.cancelOrder(cancel)
      },
    }),

    // --- Algo trading (paper-only, kill-gated) ----------------------------

    'algo_list': tool({
      description:
        'List the user\'s authored algo strategies. Use this when they ask "what strategies do I have", "show my algos", or before backtesting/enabling so you have an id.',
      inputSchema: z.object({}),
      execute: async () => {
        const { getAlgoApi } = await import('./http')
        return { strategies: await getAlgoApi().listStrategies() }
      },
    }),

    'algo_backtest': tool({
      description:
        'Run a backtest of a strategy against the last N daily bars of its configured symbol. Returns equity curve, trades, and metrics (PnL, win-rate, max-DD, Sharpe). Pure read — no orders are placed.',
      inputSchema: z.object({
        strategy_id: z.string().describe('uuid of the strategy from algo_list'),
        bars: z.number().int().min(10).max(2000).default(200),
      }),
      execute: async ({ strategy_id, bars }) => {
        const { getAlgoApi } = await import('./http')
        return getAlgoApi().backtest(strategy_id, { bars })
      },
    }),

    'algo_recent_signals': tool({
      description:
        'Recent live-tick signals emitted by the scheduler. Each signal is a paper-trade attempt the strategy fired on its cadence — order_id is set if the paper order placed, error explains why it didn\'t.',
      inputSchema: z.object({
        strategy_id: z.string().optional().describe('omit to see signals across all strategies'),
        limit: z.number().int().min(1).max(200).default(20),
      }),
      execute: async ({ strategy_id, limit }) => {
        const { getAlgoApi } = await import('./http')
        return { signals: await getAlgoApi().listSignals({ strategy_id, limit }) }
      },
    }),

    'algo_state': tool({
      description:
        'Algo system state: whether the kill switch is active and which strategies are currently enabled (live).',
      inputSchema: z.object({}),
      execute: async () => {
        const { getAlgoApi } = await import('./http')
        return getAlgoApi().state()
      },
    }),

    'algo_kill': tool({
      description:
        'EMERGENCY: activate the global kill switch. Live ticks still run and signals still get logged, but no orders will be placed until algo_unkill. Use this when the user says "stop", "kill all", "halt the algos", or after seeing a signal sequence go wrong.',
      inputSchema: z.object({}),
      execute: async () => {
        const { getAlgoApi } = await import('./http')
        return getAlgoApi().kill()
      },
    }),

    'algo_unkill': tool({
      description:
        'Release the global kill switch. Strategies that were already enabled will resume placing paper orders on their cadence.',
      inputSchema: z.object({}),
      execute: async () => {
        const { getAlgoApi } = await import('./http')
        return getAlgoApi().unkill()
      },
    }),

    // --- Research (TradingAgents multi-agent debate) ---------------------

    'agents_debate': tool({
      description:
        'Run the TradingAgents multi-agent pipeline (analysts → bull/bear debate → trader → risk gate) on a symbol. Streams progress; returns a final structured verdict with rating, confidence, and rationale. Use when the user asks for a comprehensive analysis or wants the agents to deliberate on a ticker.',
      inputSchema: z.object({
        symbol: z.string().describe('Ticker symbol, e.g. AAPL or US.NVDA'),
        max_debate_rounds: z.number().int().min(1).max(3).default(1),
        deep_thinking: z.boolean().default(true),
      }),
      // Async generator: each yield is sent as a `tool-output-available`
      // (preliminary) frame on the chat stream. This serves two purposes:
      //   1. Keeps the outer /api/chat connection alive during the 30-60s
      //      pipeline run — without periodic bytes the socket goes idle and
      //      the browser's useChat hook stays stuck in 'streaming' even
      //      after the server completes.
      //   2. Surfaces the per-step node timeline (market → social → news →
      //      fundamentals → bull/bear → trader → risk gate) to the chat UI,
      //      which AgentsDebateCard renders.
      // The return value is the FINAL output the LLM consumes.
      execute: async function* (args) {
        // Yield immediately so the chat stream gets a frame before we even
        // start the upstream fetch — no dead air between the LLM's tool
        // call and the first agent event.
        const events: Array<{ type: 'node-start'; node: string }> = []
        yield { events: [...events] }

        const baseUrl = process.env.NUXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        // Forward the caller's session cookie. Without it, the self-fetch
        // hits server/middleware/auth.ts and gets a 401 — surfacing in chat
        // as "agents service failed: 401".
        const sessionCookie = options.event ? getCookie(options.event, 'session') : undefined
        const res = await fetch(`${baseUrl}/api/research/agents-run`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(sessionCookie ? { cookie: `session=${sessionCookie}` } : {}),
          },
          body: JSON.stringify(args),
        })
        if (!res.ok || !res.body) {
          return { events, error: `agents service failed: ${res.status}` }
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let verdict: { rating?: string; confidence?: number; rationale?: string } = {}

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const ev = JSON.parse(trimmed) as {
                type?: string
                node?: string
                rating?: string
                confidence?: number
                rationale?: string
              }
              // Only forward the structural events the UI card renders —
              // skip massive payloads (final-state) and chatty deltas
              // (node-message) so we don't bloat the message persisted to
              // agent_messages-equivalent storage on the chat side.
              if (ev.type === 'node-start' && ev.node) {
                events.push({ type: 'node-start', node: ev.node })
              }
              if (ev.type === 'decision') {
                verdict = { rating: ev.rating, confidence: ev.confidence, rationale: ev.rationale }
              }
              yield { events: [...events], ...verdict }
            } catch {
              /* skip malformed */
            }
          }
        }

        if (!verdict.rating) {
          return { events, error: 'no decision emitted' }
        }
        return { events, ...verdict }
      },
    }),

    'holdings_context': tool({
      description:
        "Get the user's current holdings for a symbol with moomoo as broker data and Ghostfolio as tracker/reconciliation data. Returns broker_quantity (moomoo live), paper_quantity (moomoo paper), tracker_quantity (Ghostfolio), owned_quantity, reconciliation status, allocation % of net worth, and cash. Use when the user asks vague questions like 'how many NVDA shares do I have', 'what's my NVDA exposure', 'do I already own X', or before recommending a trade size. Never add tracker_quantity to broker_quantity; if they differ, explain it as a reconciliation mismatch. If Ghostfolio is misconfigured the response will indicate that explicitly via ghostfolio_status — surface it to the user.",
      inputSchema: z.object({
        symbol: z.string().describe('moomoo-style symbol like US.NVDA'),
      }),
      execute: async ({ symbol }) => {
        const { getHoldingForSymbol } = await import('../lib/holdings')
        return getHoldingForSymbol(symbol)
      },
    }),
    'convert_fx': tool({
      description:
        "Convert an amount between currencies using live Yahoo FX rates (cached 1h). Useful when reasoning across the user's MYR / USD / HKD holdings. Returns the converted amount + the rate used. If the pair can't be resolved, returns rate: null and the agent should explicitly tell the user.",
      inputSchema: z.object({
        amount: z.number(),
        from: z.string().describe('ISO 4217 like USD, MYR, HKD'),
        to: z.string().describe('ISO 4217 like USD, MYR, HKD'),
      }),
      execute: async ({ amount, from, to }) => {
        const { getFxRate } = await import('../lib/yahoo')
        const rate = await getFxRate(from, to)
        if (rate == null) return { ok: false, rate: null, converted: null, from, to }
        return { ok: true, rate, converted: amount * rate, from, to }
      },
    }),

    'usage_summary': tool({
      description:
        'Recent LLM usage summary: total cost today/week, breakdown by source. Use when the user asks "how much have I spent" or "is research expensive".',
      inputSchema: z.object({}),
      execute: async () => {
        const { getLlmUsageSummary, getOwnerId } = await import('../db/repo')
        const ownerId = await getOwnerId()
        return getLlmUsageSummary(ownerId)
      },
    }),
  }
}
