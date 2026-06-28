import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'

describe('buildSystemPrompt — research suite guidance', () => {
  const p = buildSystemPrompt('not_configured')
  it('documents the investment_research memo sections and presets', () => {
    expect(p).toMatch(/investment_research/)
    expect(p).toMatch(/Bull.*Bear/i)
    expect(p).toMatch(/preset/i)
  })
  it('documents the dyp_ask reasoning structure', () => {
    expect(p).toMatch(/dyp_ask/)
    expect(p).toMatch(/first.principles/i)
    expect(p).toMatch(/what would change/i)
  })
  it('lists the slash commands', () => {
    expect(p).toMatch(/\/investment-research/)
    expect(p).toMatch(/\/thesis-tracker/)
  })
})
