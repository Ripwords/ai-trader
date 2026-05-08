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
        maxResults: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, maxResults }) => {
        const apiKey = process.env.TAVILY_API_KEY ?? ''
        if (!apiKey) throw new Error('TAVILY_API_KEY not set')
        const r = await tavilySearch(apiKey, query, 'general', maxResults)
        return { results: r.results }
      },
    }),

    'search_news': tool({
      description: 'Search recent news (headlines, market events) for a company or topic.',
      inputSchema: z.object({
        query: z.string(),
        maxResults: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ query, maxResults }) => {
        const apiKey = process.env.TAVILY_API_KEY ?? ''
        if (!apiKey) throw new Error('TAVILY_API_KEY not set')
        const r = await tavilySearch(apiKey, query, 'news', maxResults)
        return { results: r.results }
      },
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

interface TavilyResponse {
  results: { title: string; url: string; content: string; published_date?: string }[]
}

async function tavilySearch(
  apiKey: string,
  query: string,
  topic: 'general' | 'news',
  maxResults: number,
): Promise<TavilyResponse> {
  const { ofetch } = await import('ofetch')
  return ofetch<TavilyResponse>('https://api.tavily.com/search', {
    method: 'POST',
    body: { api_key: apiKey, query, topic, max_results: maxResults, include_answer: false },
  })
}
