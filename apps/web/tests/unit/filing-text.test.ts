import { describe, expect, it } from 'vitest'
import { filingHtmlToText, prioritiseSections } from '../../server/lib/filing-text'

// Shaped like an EDGAR EX-99.1: inline-XBRL header, styled divs, tables with
// "$" and ")" split into their own cells, entities everywhere.
const RELEASE_HTML = `<html><head><title>Document</title><style>.x{color:red}</style></head><body>
<div style="display:none"><ix:header><ix:hidden>hidden-xbrl-context</ix:hidden></ix:header></div>
<div><span style="font-weight:700">AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS</span></div>
<div><span>&#8226;Net sales increased 12% to $201.9&#160;billion, compared with $180.2 billion. Excluding the $0.9&#160;billion unfavorable impact from foreign exchange&#8230;</span></div>
<div><span>&#8226;AWS segment sales increased 39% year-over-year to $46.0 billion.</span></div>
<p>Net income decreased to $20.7 billion, driven by pre-tax gains of $9.5 billion in Q3 2025 from our investments in Anthropic &amp; others.</p>
<table>
<tr><td></td><td colspan="3">Three Months Ended</td></tr>
<tr><td><span>Net cash provided by (used in) operating activities</span></td><td>$</td><td>35,525</td><td></td><td>$</td><td>42,422</td><td></td></tr>
<tr><td>Purchases of property and equipment</td><td>(35,095</td><td>)</td><td>(77,259</td><td>)</td></tr>
<tr><td>Operating margin</td><td>9.7</td><td>%</td><td>13.9</td><td>%</td></tr>
<tr><td>&#160;</td><td></td></tr>
</table>
<script>alert(1)</script>
</body></html>`

describe('filingHtmlToText', () => {
  it('keeps the narrative and drops markup, scripts, styles and hidden XBRL', () => {
    const text = filingHtmlToText(RELEASE_HTML)
    expect(text).toContain('AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS')
    expect(text).toContain('• Net sales increased 12% to $201.9 billion')
    expect(text).toContain('Anthropic & others')
    expect(text).not.toContain('hidden-xbrl-context')
    expect(text).not.toContain('alert(1)')
    expect(text).not.toContain('color:red')
    expect(text).not.toMatch(/<[a-z]/i)
    expect(text).not.toContain('&#')
  })

  it('drops the EDGAR SGML document wrapper (TYPE, SEQUENCE, FILENAME, DESCRIPTION)', () => {
    const html = '<DOCUMENT>\n<TYPE>EX-99.1\n<SEQUENCE>2\n<FILENAME>amzn-20260930xex991.htm\n<DESCRIPTION>EX-99.1\n<TEXT>\n<html><body><div>AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS</div></body></html>\n</TEXT>\n</DOCUMENT>'
    expect(filingHtmlToText(html)).toBe('AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS')
  })

  it('renders table rows as label | value cells with $ and ) glued back on', () => {
    const text = filingHtmlToText(RELEASE_HTML)
    expect(text).toContain('Net cash provided by (used in) operating activities | $35,525 | $42,422')
    expect(text).toContain('Purchases of property and equipment | (35,095) | (77,259)')
    expect(text).toContain('Operating margin | 9.7% | 13.9%')
    expect(text).toContain('| Three Months Ended')
    // Rows that are only padding vanish.
    expect(text.split('\n').some(l => /^\s*\|?\s*$/.test(l) && l.includes('|'))).toBe(false)
  })
})

function section(heading: string, body: string, lines = 1): string {
  return [heading, ...Array.from({ length: lines }, (_, i) => `${body} line ${i}.`)].join('\n')
}

describe('prioritiseSections', () => {
  const doc = [
    section('ACME ANNOUNCES THIRD QUARTER RESULTS', '• Revenue rose 10%', 3),
    section('Some other highlights since the last earnings announcement', '• Launched a widget with a long description', 40),
    section('Financial Guidance', '• Revenue is expected to be between $1 and $2', 3),
    section('Forward-Looking Statements', 'These statements are risky and long', 30),
    section('Consolidated Statements of Cash Flows', 'Net cash provided by operating activities | 1 | 2', 5),
    section('Segment Information', 'AWS | Net sales | 46,000', 5),
    section('Consolidated Balance Sheets', 'Total assets | 1 | 2', 5),
  ].join('\n')

  it('returns the whole text untouched when it fits', () => {
    const out = prioritiseSections(doc, 1_000_000)
    expect(out.truncated).toBe(false)
    expect(out.text).toBe(doc)
    expect(out.omitted).toEqual([])
  })

  it('keeps headline, guidance, segments and cash flow over boilerplate when over budget', () => {
    const out = prioritiseSections(doc, 1_200)
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(1_200 + 400) // omission markers are small
    expect(out.text).toContain('Revenue rose 10%')
    expect(out.text).toContain('Financial Guidance')
    expect(out.text).toContain('Revenue is expected to be between')
    expect(out.text).toContain('Segment Information')
    expect(out.text).toContain('Consolidated Statements of Cash Flows')
    expect(out.text).not.toContain('These statements are risky')
    expect(out.omitted).toContain('Forward-Looking Statements')
    expect(out.omitted).toContain('Some other highlights since the last earnings announcement')
  })

  it('keeps sections in document order and marks every omission', () => {
    const out = prioritiseSections(doc, 1_200)
    const t = out.text
    expect(t.indexOf('Revenue rose 10%')).toBeLessThan(t.indexOf('Financial Guidance'))
    expect(t.indexOf('Financial Guidance')).toBeLessThan(t.indexOf('Segment Information'))
    expect(t).toContain('[omitted: Forward-Looking Statements]')
  })
})
