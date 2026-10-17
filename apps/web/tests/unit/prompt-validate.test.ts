import { describe, expect, it } from 'vitest'
import { parseTemplateFields, validatePromptText, MAX_PROMPT_CHARS } from '../../server/lib/prompts/validate'

describe('parseTemplateFields — mirrors string.Formatter.parse', () => {
  it('collects plain fields and treats doubled braces as literals', () => {
    expect(parseTemplateFields('Hi {ticker} on {current_date}; json {{"a": 1}}')).toEqual({
      ok: true,
      fields: ['ticker', 'current_date'],
    })
  })

  it('reads the field name before a conversion or format spec', () => {
    expect(parseTemplateFields('{ticker!r} {price:>10}')).toEqual({ ok: true, fields: ['ticker', 'price'] })
  })

  it('rejects a single closing brace', () => {
    const r = parseTemplateFields('a } b')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/single '}'/i)
  })

  it('rejects an unclosed opening brace', () => {
    const r = parseTemplateFields('a { b')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/single '{'/i)
  })

  it('rejects an empty (positional) field', () => {
    const r = parseTemplateFields('value: {}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/empty/i)
  })

  it('rejects a JSON-looking block whose braces are not doubled', () => {
    expect(parseTemplateFields('reply as {"rating": "buy"}').ok).toBe(false)
  })
})

describe('validatePromptText', () => {
  const agents = { engine: 'agents' as const, placeholders: ['ticker', 'current_date'] }

  it('accepts an agents template that uses a subset of the default placeholders', () => {
    expect(validatePromptText('Look at {ticker}.', agents)).toEqual({ ok: true, warnings: [] })
  })

  it('rejects an unknown placeholder and names the allowed ones', () => {
    const r = validatePromptText('Look at {symbol}.', agents)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('{symbol}')
      expect(r.error).toContain('{ticker}')
    }
  })

  it('tells the user to double a stray brace', () => {
    const r = validatePromptText('Return {"a": 1}', agents)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/\{\{/)
  })

  it('does not parse braces in web prompts, which are plain text', () => {
    expect(validatePromptText('Return {"a": 1} and a lone }', { engine: 'web', placeholders: [] })).toEqual({ ok: true, warnings: [] })
  })

  it('rejects empty and oversized text', () => {
    expect(validatePromptText('   ', agents).ok).toBe(false)
    expect(validatePromptText('x'.repeat(MAX_PROMPT_CHARS + 1), { engine: 'web', placeholders: [] }).ok).toBe(false)
  })

  it('warns, without blocking, when an output contract is missing', () => {
    const r = validatePromptText('Decide {history}.', {
      engine: 'agents',
      placeholders: ['history'],
      contract: 'FINAL TRANSACTION PROPOSAL',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings[0]).toContain('FINAL TRANSACTION PROPOSAL')
    const kept = validatePromptText('End with FINAL TRANSACTION PROPOSAL: **BUY**. {history}', {
      engine: 'agents',
      placeholders: ['history'],
      contract: 'FINAL TRANSACTION PROPOSAL',
    })
    expect(kept).toEqual({ ok: true, warnings: [] })
  })
})
