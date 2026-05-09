import { tool } from 'ai'
import { z } from 'zod'
import type { ApiClient } from './http'

/**
 * Tool catalogue for the trading copilot. All tools are simple
 * Vercel AI SDK `tool()` definitions — no abstraction layer.
 *
 * The `id` of each (the key in the returned record) is what the agent
 * sees as the tool name. Use kebab-or-dotted names; the chat UI renders
 * them in the UChatTool indicator.
 */
export function makeTools(client: ApiClient) {
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
        '(trd_env=REAL) unless the user explicitly says "live" or "real". For NORMAL (limit) orders ' +
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
      }),
      execute: async (args) => client.placeOrder(args),
    }),

    'trade_modify_order': tool({
      description:
        'Modify an existing order\'s price and/or quantity. acc_id required. trd_env defaults to SIMULATE.',
      inputSchema: z.object({
        order_id: z.string(),
        acc_id: z.string(),
        price: z.number().optional(),
        qty: z.number().int().optional(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
      }),
      execute: async (args) => client.modifyOrder(args),
    }),

    'trade_cancel_order': tool({
      description: 'Cancel an existing order by order_id. acc_id required.',
      inputSchema: z.object({
        order_id: z.string(),
        acc_id: z.string(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
      }),
      execute: async (args) => client.cancelOrder(args),
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

    // --- Research (multi-analyst + LLM personas) --------------------------

    'research_ticker': tool({
      description:
        'Run a multi-perspective research pass on a symbol: deterministic analysts (fundamentals/valuation/technicals/sentiment) plus selected LLM investor personas (Buffett, Munger, Burry, Druckenmiller, Wood). Returns a list of signals each with confidence + reasoning. Read-only.',
      inputSchema: z.object({
        symbol: z.string().describe('moomoo-style symbol like US.NVDA'),
        personas: z
          .array(z.enum(['buffett', 'munger', 'burry', 'druckenmiller', 'wood']))
          .default(['buffett', 'burry', 'wood'])
          .describe('which LLM personas to include'),
        analysts: z
          .array(z.enum(['fundamentals', 'valuation', 'technicals', 'sentiment']))
          .default(['fundamentals', 'valuation', 'technicals', 'sentiment']),
      }),
      execute: async ({ symbol, personas, analysts }) => {
        const { getResearchApi } = await import('./http')
        const { findPersona, runPersona } = await import('./personas')
        const yahoo = await import('../lib/yahoo')
        const { getHoldingForSymbol } = await import('../lib/holdings')
        const api = getResearchApi()

        const [metrics, history, insider, news, holdings, earnings] = await Promise.all([
          yahoo.getFinancialMetrics(symbol),
          yahoo.getHistorical(symbol, 5),
          yahoo.getInsiderTrades(symbol, 200),
          yahoo.getCompanyNews(symbol, 50),
          getHoldingForSymbol(symbol),
          yahoo.getEarningsInfo(symbol),
        ])
        const bundle = { metrics, history }

        const analystSignals = await Promise.all(
          analysts.map((name) => {
            if (name === 'fundamentals' || name === 'valuation') {
              return api.runAnalyst(name, { symbol, metrics })
            }
            if (name === 'sentiment') {
              return api.runAnalyst(name, { symbol, insider, news })
            }
            return api.runAnalyst(name, { symbol })
          }),
        )

        const personaSignals = await Promise.all(
          personas.map((id) => {
            const p = findPersona(id)
            if (!p) throw new Error(`unknown persona: ${id}`)
            return runPersona(p, symbol, bundle, holdings, earnings)
          }),
        )

        return { symbol, signals: [...analystSignals, ...personaSignals] }
      },
    }),

    'synthesize_decisions': tool({
      description:
        'Given a set of research signals across symbols, run the risk manager + portfolio manager pipeline to produce final trade decisions (buy/sell/short/cover/hold + quantity + confidence). Read-only — does not place orders.',
      inputSchema: z.object({
        symbols: z.array(z.string()).min(1),
        signals: z
          .array(
            z.object({
              source: z.string(),
              symbol: z.string(),
              signal: z.enum(['bullish', 'bearish', 'neutral']),
              confidence: z.number().int().min(0).max(100),
              reasoning: z.string(),
            }),
          )
          .optional()
          .describe('omit to fetch fresh signals from /research/* — slower but always current'),
      }),
      execute: async ({ symbols, signals }) => {
        const { getResearchApi } = await import('./http')
        return getResearchApi().synthesizeDecisions({ symbols, signals })
      },
    }),

    'analyze_ticker': tool({
      description:
        'COMPREHENSIVE ticker analysis via the Mastra workflow: fetches fundamentals, runs all 4 deterministic analysts AND all 5 LLM investor personas (Buffett/Munger/Burry/Druckenmiller/Wood), persists every signal, then synthesizes a final risk-managed decision. Returns a markdown report ready to show the user. Slower than research_ticker — use when the user asks for a deep dive, a full analysis, or "analyze X comprehensively".',
      inputSchema: z.object({
        symbol: z.string().describe('moomoo-style symbol like US.NVDA'),
      }),
      execute: async ({ symbol }) => {
        const { analyzeTickerWorkflow } = await import('../mastra')
        const run = await analyzeTickerWorkflow.createRun()
        const result = await run.start({
          inputData: {
            symbol,
            analysts: ['fundamentals', 'valuation', 'technicals', 'sentiment'],
            personas: ['buffett', 'munger', 'burry', 'druckenmiller', 'wood'],
          },
        })
        if (result.status !== 'success') {
          throw new Error(`analyze_ticker workflow status=${result.status}`)
        }
        return result.result
      },
    }),

    'holdings_context': tool({
      description:
        "Get the user's current holdings for a symbol across both Ghostfolio (cross-broker truth) and Moomoo (paper + live). Returns positions per source, total quantity, allocation % of net worth, unrealized P&L, and available cash. Use when the user asks vague questions like 'what's my NVDA exposure', 'do I already own X', or before recommending a trade size. If Ghostfolio is misconfigured the response will indicate that explicitly via ghostfolio_status — surface it to the user.",
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
  }
}

interface NewsResult {
  title: string
  url: string
  content: string
  published_date?: string
}

type SearchKind = 'web' | 'news'

/**
 * Try the primary search provider first, fall back to the other. Picks
 * primary from process.env.SEARCH_PROVIDER ('brave' | 'tavily', default
 * 'brave'). A provider with no API key is skipped silently. If both
 * providers fail, throws the last error so the agent can surface it.
 */
async function searchWithFallback(kind: SearchKind, query: string, maxResults: number): Promise<NewsResult[]> {
  const primary = (process.env.SEARCH_PROVIDER as 'brave' | 'tavily' | undefined) || 'brave'
  const order: ('brave' | 'tavily')[] = primary === 'tavily' ? ['tavily', 'brave'] : ['brave', 'tavily']

  let lastErr: unknown
  for (const provider of order) {
    const key = provider === 'brave' ? process.env.BRAVE_API_KEY : process.env.TAVILY_API_KEY
    if (!key) continue
    try {
      const results = provider === 'brave'
        ? await braveSearch(key, kind, query, maxResults)
        : await tavilySearch(key, kind, query, maxResults)
      if (results.length > 0) return results
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) throw lastErr
  throw new Error('No search provider configured. Set BRAVE_API_KEY and/or TAVILY_API_KEY.')
}

interface BraveWebResponse {
  web?: { results?: { title: string; url: string; description: string; age?: string; page_age?: string }[] }
}
interface BraveNewsResponse {
  results?: { title: string; url: string; description: string; age?: string; page_age?: string }[]
}

async function braveSearch(apiKey: string, kind: SearchKind, query: string, maxResults: number): Promise<NewsResult[]> {
  const { ofetch } = await import('ofetch')
  const url = kind === 'news'
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search'
  const raw = await ofetch<BraveWebResponse | BraveNewsResponse>(url, {
    query: { q: query, count: maxResults },
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  const items = kind === 'news'
    ? (raw as BraveNewsResponse).results ?? []
    : (raw as BraveWebResponse).web?.results ?? []
  return items.slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    content: r.description,
    published_date: r.page_age || r.age,
  }))
}

interface TavilyResponse {
  results: { title: string; url: string; content: string; published_date?: string }[]
}

async function tavilySearch(apiKey: string, kind: SearchKind, query: string, maxResults: number): Promise<NewsResult[]> {
  const { ofetch } = await import('ofetch')
  const r = await ofetch<TavilyResponse>('https://api.tavily.com/search', {
    method: 'POST',
    body: {
      api_key: apiKey,
      query,
      topic: kind === 'news' ? 'news' : 'general',
      max_results: maxResults,
      include_answer: false,
    },
  })
  return r.results.map(x => ({
    title: x.title,
    url: x.url,
    content: x.content,
    published_date: x.published_date,
  }))
}
