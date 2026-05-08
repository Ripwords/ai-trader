import { generateObject } from 'ai'
import { z } from 'zod'
import { buildModel } from '../model'
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

export async function runPersona(persona: Persona, symbol: string, bundle: unknown): Promise<Signal> {
  const { object } = await generateObject({
    model: buildModel(),
    schema: SignalSchema,
    system: persona.prompt,
    prompt: `Analyze ${symbol} given this fundamentals data:\n\n${JSON.stringify(bundle, null, 2)}\n\nReturn your signal.`,
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
