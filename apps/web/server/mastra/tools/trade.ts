import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ApiClient } from '../http'

export function makeTradeTools(client: ApiClient) {
  const accounts = createTool({
    id: 'trade.accounts',
    description: 'List the user\'s moomoo accounts. Use when they ask about their accounts.',
    inputSchema: z.object({}),
    execute: async () => ({ accounts: await client.listAccounts() }),
  })

  const portfolio = createTool({
    id: 'trade.portfolio',
    description: 'Get the user\'s positions and cash balance for an account. Use when they ask about portfolio, positions, or holdings.',
    inputSchema: z.object({
      acc_id: z.number().int(),
      trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
    }),
    execute: async (input) => client.getPortfolio(input),
  })

  const orders = createTool({
    id: 'trade.orders',
    description: 'List today\'s orders for an account. Use when they ask about open orders or recent orders.',
    inputSchema: z.object({
      acc_id: z.number().int(),
      trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
    }),
    execute: async (input) => ({ orders: await client.listOrders(input) }),
  })

  const fills = createTool({
    id: 'trade.fills',
    description: 'List today\'s fills (executed trades) for an account.',
    inputSchema: z.object({
      acc_id: z.number().int(),
      trd_env: z.enum(['SIMULATE', 'REAL']).default('SIMULATE'),
    }),
    execute: async (input) => ({ fills: await client.listFills(input) }),
  })

  return { accounts, portfolio, orders, fills }
}
