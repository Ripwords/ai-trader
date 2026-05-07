import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import type { ApiClient } from '../http'

const klineInputSchema = z.object({
  code: z.string().describe('moomoo symbol like US.NVDA, HK.00700, SH.600519'),
  ktype: z.enum(['1m', '3m', '5m', '15m', '30m', '60m', '1d', '1w', '1M']).default('1d'),
  num: z.number().int().min(1).max(1000).default(60),
})

const snapshotInputSchema = z.object({
  code: z.string(),
})

export function makeMarketTools(client: ApiClient) {
  const kline = createTool({
    id: 'market.kline',
    description:
      'Fetch candlestick (k-line) bars for a symbol. Use when the user asks for charts, trends, or historical price.',
    inputSchema: klineInputSchema,
    execute: async (inputData) => client.getKline(inputData),
  })

  const snapshot = createTool({
    id: 'market.snapshot',
    description:
      'Fetch latest quote snapshot for a symbol. Use when the user asks "what is the price of X".',
    inputSchema: snapshotInputSchema,
    execute: async (inputData) => client.getSnapshot(inputData),
  })

  return { kline, snapshot }
}
