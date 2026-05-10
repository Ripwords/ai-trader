import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it } from 'vitest'

type PricingEntry = { input_per_1m: number; output_per_1m: number }
type Handler = (event: H3Event) => { models: Record<string, PricingEntry> } | Promise<{ models: Record<string, PricingEntry> }>
let handler: Handler
beforeEach(async () => {
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/internal/pricing.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>): H3Event {
  return { node: { req: { headers } }, context: {}, path: '/' } as unknown as H3Event
}

describe('/internal/pricing', () => {
  it('rejects without bearer', async () => {
    expect(() => handler(makeEvent({}))).toThrow()
  })

  it('returns models map on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' })
    const result = await handler(event)
    expect(result.models).toBeDefined()
    const keys = Object.keys(result.models)
    expect(keys.length).toBeGreaterThan(0)
    // Sanity check at least one Anthropic entry exists with the expected shape.
    const anthropic = keys.find(k => k.startsWith('anthropic/'))
    expect(anthropic).toBeDefined()
    expect(typeof result.models[anthropic!].input_per_1m).toBe('number')
    expect(typeof result.models[anthropic!].output_per_1m).toBe('number')
  })
})
