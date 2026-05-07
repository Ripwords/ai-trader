import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ApiClient } from '../http'

export function makeWatchlistTools(client: ApiClient) {
  const list = createTool({
    id: 'watchlist.list',
    description: 'List the user\'s watchlist symbols. Use when they ask "what\'s on my watchlist", "my list", "what am I tracking".',
    inputSchema: z.object({ group: z.string().default('All') }),
    execute: async (input) => client.listWatchlist(input),
  })

  const add = createTool({
    id: 'watchlist.add',
    description: 'Add a symbol to the user\'s watchlist. Use when they ask to "add X to my watchlist" or "watch X".',
    inputSchema: z.object({
      code: z.string().describe('moomoo symbol like US.NVDA, HK.00700'),
      group: z.string().default('All'),
    }),
    execute: async (input) => client.addWatchlistItem(input),
  })

  const remove = createTool({
    id: 'watchlist.remove',
    description: 'Remove a symbol from the user\'s watchlist.',
    inputSchema: z.object({
      code: z.string(),
      group: z.string().default('All'),
    }),
    execute: async (input) => client.removeWatchlistItem(input),
  })

  return { list, add, remove }
}
