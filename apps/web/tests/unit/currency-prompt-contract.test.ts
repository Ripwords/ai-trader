import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'

/**
 * Guards the currency / valuation narration rules without invoking a model.
 *
 * The regression: the chat divided a USD position by the MYR portfolio total
 * ("US$955 is ~1.2% of your portfolio", really 5.3%) and labelled an RM sizing
 * figure as USD — both off by the USD/MYR rate. The existing rule only banned
 * adding across currencies.
 */

const prompt = buildSystemPrompt('ok')

function block(heading: string): string {
  const start = prompt.indexOf(heading)
  expect(start, `missing block ${heading}`).toBeGreaterThan(-1)
  const end = prompt.indexOf('\n\n', start)
  return prompt.slice(start, end === -1 ? undefined : end)
}

describe('currency prompt contract', () => {
  it('bans dividing across currencies, not just adding', () => {
    const b = block('CURRENCY ARITHMETIC')
    expect(b).toMatch(/divid/i)
    expect(b).toContain('convert_fx')
    expect(b).toContain('weight_pct')
  })

  it('places the arithmetic rule after the CURRENCY block', () => {
    expect(prompt.indexOf('CURRENCY ARITHMETIC')).toBeGreaterThan(prompt.indexOf('CURRENCY:'))
  })

  it('states the MYR conversion constraint as the user\'s, and keeps cash separate', () => {
    const b = block('MALAYSIA CASH & FX')
    expect(b).toMatch(/user's (operating )?constraint/i)
    expect(b).toMatch(/not .*law|never as law/i)
    expect(b).toMatch(/hedges? oil/i)
  })

  it('distrusts flagged or out-of-regime DCF output', () => {
    const b = block('VALUATION OUTPUT')
    expect(b).toContain('warnings')
    expect(b).toContain('reverse_dcf_implied_growth')
  })

  it('requires screen health to be reported per row', () => {
    const b = block('SCREEN OUTPUT')
    expect(b).toContain('veto')
    expect(b).toContain('data_quality')
    expect(b).toContain('unavailable')
    expect(b).toContain('truncated')
  })

  it('carries no dated portfolio snapshot figures', () => {
    for (const stale of [/4\.80/, /4\.08/, /\b96%/, /\b72%/, /\b48%/, /\bKO\b/, /\bVZ\b/, /\bPFE\b/]) {
      expect(prompt, `stale figure ${stale}`).not.toMatch(stale)
    }
  })
})
