import { describe, it, expect } from 'vitest'
import { slashDispatch } from '../../server/llm/research/dispatch'

describe('slashDispatch', () => {
  it('returns null for natural language', () => {
    expect(slashDispatch('what is NVDA worth?')).toBeNull()
  })
  it('forces investment_research with preset + symbol for a memo command', () => {
    const d = slashDispatch('/investment-team 美团')!
    expect(d.toolName).toBe('investment_research')
    expect(d.directive).toContain('investment_research')
    expect(d.directive).toContain('美团')
    expect(d.directive).toContain('team')
  })
  it('forces management-deep-dive with person + symbol', () => {
    const d = slashDispatch('/management-deep-dive 王兴 美团')!
    expect(d.toolName).toBe('investment_research')
    expect(d.directive).toContain('王兴')
    expect(d.directive).toContain('美团')
    expect(d.directive).toContain('management')
  })
  it('forces dyp_ask with the question', () => {
    const d = slashDispatch('/dyp-ask 拼多多的护城河到底在哪里？')!
    expect(d.toolName).toBe('dyp_ask')
    expect(d.directive).toContain('拼多多的护城河到底在哪里')
  })
})
