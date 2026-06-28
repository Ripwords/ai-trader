import { describe, it, expect } from 'vitest'
import { stepToolChoice } from '../../server/llm/research/dispatch'
describe('stepToolChoice', () => {
  it('forces the tool on step 0', () => {
    expect(stepToolChoice('investment_research', 0)).toEqual({ type: 'tool', toolName: 'investment_research' })
  })
  it('reverts to auto on later steps (so the model writes prose)', () => {
    expect(stepToolChoice('investment_research', 1)).toBe('auto')
    expect(stepToolChoice('investment_research', 5)).toBe('auto')
  })
})
