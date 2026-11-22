import { describe, it, expect } from 'vitest'
import { excerptKeyPoints, splitSentences } from '../../server/lib/agents/excerpt'

const RULING = [
  'My ruling is **HOLD**, a deliberate, risk-budgeted hold. The business is improving while the stock sits below the levels that would justify new buying.',
  '',
  '## Key Arguments from the Debate',
  '',
  '### Aggressive Analyst',
  '- The operating inflection is real and the franchise keeps compounding quarter after quarter in every segment that matters to the long-run thesis.',
  '- Record operating income of $28.08B at a 13.9% margin, with AWS growth at 39.3%.',
  '',
  '### Conservative Analyst',
  '- Demand is not the same as return on capital, and nobody on the bull side has shown the capex earns its cost.',
  '- Long-term debt rose from $65.6B to $173.1B and interest expense tripled to $1.69B per quarter.',
  '',
  '## Refined Plan',
  '',
  '### Exit Protocol',
  '- A daily close below 229.36 reduces exposure to the minimum size.',
  '- A hard exit below 226.13 regardless of volume.',
  '- Patience is the whole point of this plan and discipline matters more than conviction here.',
  '',
  '### Re-entry',
  '- First tranche only after two consecutive daily closes above 250.72.',
  '',
  'FINAL TRANSACTION PROPOSAL: **HOLD**',
].join('\n')

describe('splitSentences', () => {
  it('splits prose at sentence ends', () => {
    expect(splitSentences('Margins rose. Debt rose too! Is that fine? Yes.')).toEqual([
      'Margins rose.', 'Debt rose too!', 'Is that fine?', 'Yes.',
    ])
  })

  it('never splits inside a number', () => {
    expect(splitSentences('Operating income hit $28.08B at a 13.9% margin. AWS grew 39.3%.')).toEqual([
      'Operating income hit $28.08B at a 13.9% margin.', 'AWS grew 39.3%.',
    ])
  })

  it('does not split after an abbreviation or an initial', () => {
    expect(splitSentences('The U.S. Treasury yield is 5.3% vs. Azure growth. Next.')).toEqual([
      'The U.S. Treasury yield is 5.3% vs. Azure growth.', 'Next.',
    ])
  })
})

describe('excerptKeyPoints', () => {
  it('returns text that already fits unchanged apart from bold markers', () => {
    const out = excerptKeyPoints('Buy **now** above $240.', { maxChars: 200 })
    expect(out).toEqual({ text: 'Buy now above $240.', mode: 'full' })
  })

  it('stays within the budget', () => {
    for (const maxChars of [300, 500, 800]) {
      expect(excerptKeyPoints(RULING, { maxChars, leadChars: 200 }).text.length).toBeLessThanOrEqual(maxChars)
    }
  })

  it('keeps the opening ruling, then the points that carry figures and levels', () => {
    const out = excerptKeyPoints(RULING, { maxChars: 620, leadChars: 200 })
    expect(out.mode).toBe('key-points')
    expect(out.text.startsWith('My ruling is HOLD, a deliberate, risk-budgeted hold.')).toBe(true)
    expect(out.text).toContain('- A hard exit below 226.13 regardless of volume.')
    expect(out.text).toContain('- A daily close below 229.36 reduces exposure to the minimum size.')
    expect(out.text).toContain('- First tranche only after two consecutive daily closes above 250.72.')
    expect(out.text).not.toContain('Patience is the whole point')
    expect(out.text).not.toContain('The operating inflection is real')
    expect(out.text).not.toContain('FINAL TRANSACTION PROPOSAL')
  })

  it('labels each kept point with the heading it sat under, in the original order', () => {
    const out = excerptKeyPoints(RULING, { maxChars: 620, leadChars: 200 })
    const exit = out.text.indexOf('Exit Protocol')
    const reentry = out.text.indexOf('Re-entry')
    expect(exit).toBeGreaterThan(-1)
    expect(reentry).toBeGreaterThan(exit)
    expect(out.text.indexOf('226.13')).toBeGreaterThan(exit)
    expect(out.text.indexOf('226.13')).toBeLessThan(reentry)
    expect(out.text).not.toContain('#')
  })

  it('keeps every kept point whole', () => {
    const out = excerptKeyPoints(RULING, { maxChars: 400, leadChars: 120 })
    const source = RULING.replaceAll('**', '')
    for (const line of out.text.split('\n').filter(l => l.startsWith('- '))) {
      expect(source).toContain(line)
    }
  })

  it('sets each heading apart with a blank line, so markdown does not fold it into the point above', () => {
    const out = excerptKeyPoints(RULING, { maxChars: 400, leadChars: 120 })
    const lines = out.text.split('\n')
    const headings = lines.flatMap((line, i) => (i > 0 && line && !line.startsWith('- ') ? [i] : []))
    expect(headings.length).toBeGreaterThan(0)
    for (const i of headings) expect(lines[i - 1]).toBe('')
  })

  it('falls back to the opening sentences when the text carries no figures', () => {
    const prose = Array.from({ length: 12 }, (_, i) => `Point ${'x'.repeat(i)} about moat and management quality stands.`)
      .join(' ')
      .replaceAll(/\d/g, '')
    const out = excerptKeyPoints(prose, { maxChars: 160 })
    expect(out.mode).toBe('head')
    expect(out.text.length).toBeLessThanOrEqual(160)
    expect(out.text.endsWith('.')).toBe(true)
    expect(prose.startsWith(out.text)).toBe(true)
  })

  it('cuts one oversized sentence at a word, never after a figure', () => {
    const long = `The base case assumes revenue of $28.08 billion growing at 13.9 percent while ${'capital intensity stays elevated and '.repeat(8)}margins hold`
    const out = excerptKeyPoints(long, { maxChars: 50 })
    expect(out.mode).toBe('head')
    expect(out.text.length).toBeLessThanOrEqual(50)
    expect(out.text).toMatch(/…$/)
    expect(out.text).not.toMatch(/\d\s*…$/)
    expect(out.text).toBe('The base case assumes revenue of…')
  })

  it('reads table rows and quoted lines as points', () => {
    const text = [
      'Summary of the scenarios the desk weighed before ruling on the position and its sizing today.',
      '',
      '| Scenario | Weight |',
      '|---|---|',
      '| Chop | 45% |',
      '| Bear continuation | 35% |',
      '',
      '> You do not pounce on a 20% scenario.',
      '',
      `${'Filler sentence without any figure in it at all. '.repeat(10)}`,
    ].join('\n')
    const out = excerptKeyPoints(text, { maxChars: 220 })
    expect(out.text).toContain('- Chop | 45%')
    expect(out.text).toContain('- You do not pounce on a 20% scenario.')
  })
})
