import { describe, it, expect } from 'vitest'
import { parseVerdictReport } from '../../app/lib/verdictReport'

describe('parseVerdictReport', () => {
  it('splits markdown ATX headings into titled sections', () => {
    const md = [
      '## Summary of Key Arguments',
      'Bulls like the FCF yield.',
      '',
      '## Rationale',
      'Risks cancel out.',
    ].join('\n')
    const out = parseVerdictReport(md)
    expect(out.map(s => s.title)).toEqual(['Summary of Key Arguments', 'Rationale'])
    expect(out[0].body).toContain('FCF yield')
    expect(out[1].body).toContain('Risks cancel out')
  })

  it('treats bold-only lines as headings', () => {
    const md = '**Key Arguments**\nbody one\n\n**Final Recommendation**\nhold'
    const out = parseVerdictReport(md)
    expect(out.map(s => s.title)).toEqual(['Key Arguments', 'Final Recommendation'])
  })

  it('treats short numbered lines as headings but not list sentences', () => {
    const md = [
      '1. Summary of Key Arguments',
      'The aggressive analyst is bullish.',
      '2. Risks',
      '1. We could lose money if the thesis breaks.',
    ].join('\n')
    const out = parseVerdictReport(md)
    expect(out.map(s => s.title)).toEqual(['Summary of Key Arguments', 'Risks'])
    // The sentence-like numbered line stays in the body, not promoted.
    expect(out[1].body).toContain('We could lose money')
  })

  it('strips the canonical FINAL TRANSACTION PROPOSAL line', () => {
    const md = 'We stay neutral.\n\nFINAL TRANSACTION PROPOSAL: **HOLD**'
    const out = parseVerdictReport(md)
    const joined = out.map(s => s.body).join('\n')
    expect(joined).not.toMatch(/FINAL TRANSACTION PROPOSAL/i)
    expect(joined).toContain('We stay neutral')
  })

  it('keeps preamble before the first heading as an untitled section', () => {
    const md = 'Final Recommendation: HOLD\n\n## Rationale\nbecause'
    const out = parseVerdictReport(md)
    expect(out[0].title).toBeNull()
    expect(out[0].body).toContain('Final Recommendation: HOLD')
    expect(out[1].title).toBe('Rationale')
  })

  it('degrades to a single untitled section when no headings exist', () => {
    const md = 'Just a paragraph with no structure at all.'
    const out = parseVerdictReport(md)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBeNull()
    expect(out[0].body).toBe(md)
  })
})
