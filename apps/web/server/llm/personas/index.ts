import { generateObject } from 'ai'
import { z } from 'zod'
import { buildModel } from '../model'
import type { HoldingSummary } from '../../lib/holdings'
import { buffett } from './buffett'
import { burry } from './burry'
import { druckenmiller } from './druckenmiller'
import { munger } from './munger'
import type { Persona, Signal } from './types'
import { wood } from './wood'

const REGISTRY: Persona[] = [buffett, munger, burry, druckenmiller, wood]

const SignalSchema = z.object({
  signal: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.number().int().min(0).max(100),
  reasoning: z.string(),
})

function compactHoldings(h: HoldingSummary): Record<string, unknown> {
  return {
    symbol: h.symbol,
    total_quantity: h.total_quantity,
    total_market_value: h.total_market_value,
    allocation_pct: h.allocation_pct,
    net_worth_total: h.net_worth_total,
    positions: h.positions.map(p => ({
      account: p.account_label,
      quantity: p.quantity,
      avg_cost: p.avg_cost,
      current_price: p.current_price,
      market_value: p.market_value,
      unrealized_pnl_pct: p.unrealized_pnl_pct,
    })),
  }
}

export async function runPersona(
  persona: Persona,
  symbol: string,
  bundle: unknown,
  holdings?: HoldingSummary | null,
): Promise<Signal> {
  const holdingsBlock = holdings && holdings.positions.length > 0
    ? `\n\nCurrent holdings:\n${JSON.stringify(compactHoldings(holdings), null, 2)}`
    : holdings
      ? '\n\nCurrent holdings: none (user does not currently hold this symbol).'
      : ''

  const { object } = await generateObject({
    model: buildModel(),
    schema: SignalSchema,
    system: persona.prompt,
    prompt: `Analyze ${symbol} given this fundamentals data:\n\n${JSON.stringify(bundle, null, 2)}${holdingsBlock}\n\nReturn your signal.`,
  })
  return { source: `persona:${persona.id}`, symbol, ...object }
}

export function listPersonas(): Persona[] {
  return REGISTRY
}

export function findPersona(id: string): Persona | undefined {
  return REGISTRY.find(p => p.id === id)
}

export type { Persona, Signal } from './types'
