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
      description: 'Get positions and cash for an account. Read-only.',
      inputSchema: z.object({
        acc_id: z.number().int(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
      }),
      execute: async (args) => client.getPortfolio(args),
    }),

    'trade_orders': tool({
      description: 'List today\'s orders for an account.',
      inputSchema: z.object({
        acc_id: z.number().int(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
      }),
      execute: async (args) => ({ orders: await client.listOrders(args) }),
    }),

    'trade_fills': tool({
      description: 'List today\'s fills (executed trades) for an account.',
      inputSchema: z.object({
        acc_id: z.number().int(),
        trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
      }),
      execute: async (args) => ({ fills: await client.listFills(args) }),
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
