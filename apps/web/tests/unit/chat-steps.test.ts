import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CHAT_MAX_STEPS, MAX_CHAT_STEPS, resolveMaxSteps } from '../../server/llm/chat-steps'

describe('resolveMaxSteps', () => {
  const orig = process.env.CHAT_MAX_STEPS
  afterEach(() => {
    if (orig === undefined) delete process.env.CHAT_MAX_STEPS
    else process.env.CHAT_MAX_STEPS = orig
  })

  it('defaults to 30 when nothing is provided', () => {
    delete process.env.CHAT_MAX_STEPS
    expect(resolveMaxSteps(undefined)).toBe(DEFAULT_CHAT_MAX_STEPS)
    expect(DEFAULT_CHAT_MAX_STEPS).toBe(30)
  })

  it('honours a per-request value from the client', () => {
    expect(resolveMaxSteps(50)).toBe(50)
    expect(resolveMaxSteps(12)).toBe(12)
  })

  it('clamps out-of-range request values into [1, MAX]', () => {
    expect(resolveMaxSteps(0)).toBe(1)
    expect(resolveMaxSteps(-5)).toBe(1)
    expect(resolveMaxSteps(9999)).toBe(MAX_CHAT_STEPS)
  })

  it('rounds fractional values and rejects non-numbers', () => {
    expect(resolveMaxSteps(8.7)).toBe(9)
    expect(resolveMaxSteps(Number.NaN)).toBe(DEFAULT_CHAT_MAX_STEPS)
    expect(resolveMaxSteps('20' as unknown as number)).toBe(DEFAULT_CHAT_MAX_STEPS)
  })

  it('falls back to the CHAT_MAX_STEPS env when no request value is given', () => {
    process.env.CHAT_MAX_STEPS = '45'
    expect(resolveMaxSteps(undefined)).toBe(45)
  })

  it('prefers an explicit request value over the env default', () => {
    process.env.CHAT_MAX_STEPS = '45'
    expect(resolveMaxSteps(15)).toBe(15)
  })

  it('ignores an invalid env value', () => {
    process.env.CHAT_MAX_STEPS = 'lots'
    expect(resolveMaxSteps(undefined)).toBe(DEFAULT_CHAT_MAX_STEPS)
  })
})
