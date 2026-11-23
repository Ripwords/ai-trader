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

// Trimmed from a stored AMZN debate. Each speaker restates an opponent before answering.
const CONSERVATIVE = [
  'On valuation, "23x is cheap." Cheap against what? Against a 31.8 historical P/E that was earned in a different rate regime with positive free cash flow. On clean trailing numbers — stripping the non-cash investment marks — this trades at roughly 33x. And note what our own deterministic work produced: the DCF was skipped because free cash flow is negative.',
  '',
  'On the technicals being "opportunity" — I think this is the weakest link in the aggressive case. This isn\'t merely a weak tape; it\'s distribution. Heavy volume on down weeks at 74 and 105 million shares, light volume on up weeks at 25 to 43 million. Third failure at the $266 to $278 shelf. First decisive close below the $250 level that had been defended repeatedly.',
  '',
  'On AWS share — I don\'t need it to be a catastrophe to make the risk point. AWS is still the largest and most profitable cloud. But it went from roughly 28% to 26% share while Google went from 13% to 16%, Azure grew 48%, and Google Cloud grew 103% against AWS\'s 39%. In a market growing over 50%, being the slowest grower hands the bear case a data-backed rebuttal to the record-margin print.',
  '',
  'The aggressive analyst wants to build with intent at 1.4% of assets and discard that caution as timidity. So support the BUY exactly as proposed — modest, funded from the next monthly contribution, no stops, no options, no price triggers.',
].join('\n')

const BEAR = [
  '# Bear Case for AMZN — The Bull Is Buying a Narrative; I\'m Looking at the Bank Account',
  '',
  'Let me start by conceding something real, because I don\'t want to win this on a technicality: **the bull is right that the operating line was excellent.**',
  '',
  '## 1. The bull\'s own EPS reconstruction indicts his valuation',
  '',
  'The bull says: "strip out the Anthropic lap and the interest, and operating EPS was ~$1.94–2.02, in line. So the miss is theater."',
  '',
  'The bull cites 28 up / 16 down revisions on FY27 as bullish momentum. But 25 of 36 analysts cut Q4 and the FY26 skew is 29 down / 17 up. That\'s analysts marking to a lower number and calling it a raise.',
  '',
  '## 3. The Q4 "capex step-down" is a definitional guess, and the bull is treating it as a forecast',
  '',
  'He says: "$220B guide implies ~$44B of Q4 capex vs $77B in Q3 — so FCF inflects."',
  '',
  '- Q3 gross PP&E purchases of **$77.3B annualize to >$300B** — 40% above the $220B guide. Something has to give, and it might be the *definition*, not the spend.',
  '',
  'Meanwhile, the actual number: **TTM FCF −$42.4B**, from **+$14.8B a year ago.** Capex is now **128% of operating cash flow.**',
  '',
  '## 7. The technicals: the bull picked the friendlier 200-DMA',
  '',
  'The bull says "the 200-DMA held, burden of proof is on the bears." But on the rigorous read, **price is below the 10 EMA (−4.6%), below the 50 SMA (−3.2%), below the 200 SMA (−2.3%), and below VWMA (−6.0%).** Every horizon of trend is upside down.',
  '',
  'Three failures at $266–278. Lower highs: $278 → $266 → $262 → $267. RSI 42.3 — **no oversold cushion**, ~7–10 points of room before a reversion bid. The tape is weak, not washed out. There\'s room to $239, then $229–232.',
].join('\n')

const RESTATES = /^(?:the|my)\s+(?:bull|bear|aggressive|conservative|neutral)\b|^(?:he|she)\s+says\b/i

const bullets = (text: string) => text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2))

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

  it('cuts prose with no headings or bullets to one unbroken passage, not stitched sentences', () => {
    const out = excerptKeyPoints(CONSERVATIVE, { maxChars: 500, restates: RESTATES })
    expect(out.mode).toBe('passage')
    expect(out.text).toBe(CONSERVATIVE.split('\n')[4])
    expect(out.text.startsWith('On AWS share — I don\'t need it to be a catastrophe')).toBe(true)
  })

  it('never opens a passage on a quoted claim, or on the reply that only makes sense after it', () => {
    const valuation = CONSERVATIVE.split('\n')[0]!
    const out = excerptKeyPoints(`${valuation}\n\n${'Filler sentence without any figure in it at all. '.repeat(10)}`, { maxChars: 300, restates: RESTATES })
    expect(out.text).toBe(
      'On clean trailing numbers — stripping the non-cash investment marks — this trades at roughly 33x. And note what our own deterministic work produced: the DCF was skipped because free cash flow is negative.',
    )
  })

  it('never opens a point or a passage on a rebuttal word', () => {
    for (const source of [CONSERVATIVE, BEAR]) {
      for (const maxChars of [200, 300, 450, 500, 700]) {
        const out = excerptKeyPoints(source, { maxChars, restates: RESTATES })
        for (const point of [...bullets(out.text), ...(out.mode === 'passage' ? [out.text] : [])]) {
          expect(point).not.toMatch(/^(?:But|Yet|However|And|So|That|This|It)\b/)
        }
      }
    }
  })

  it('drops a rebuttal whose only antecedent is the opponent\'s claim, and the heading left with nothing under it', () => {
    const out = excerptKeyPoints(BEAR, { maxChars: 450, restates: RESTATES })
    expect(out.text).not.toContain('25 of 36 analysts')
    expect(out.text).not.toContain('The bull says')
    expect(out.text).not.toContain('He says')
    expect(out.text).not.toContain('EPS reconstruction')
    expect(out.text).not.toContain('But on the rigorous read')
    expect(out.text).toContain('Lower highs: $278 → $266 → $262 → $267.')

    const lines = out.text.split('\n')
    lines.forEach((line, i) => {
      if (line && !line.startsWith('- ')) expect(lines[i + 1]?.startsWith('- ')).toBe(true)
    })
  })

  it('joins neighbouring sentences of one paragraph into one point', () => {
    const text = [
      '## 3. The Q4 "capex step-down" is a definitional guess',
      '',
      'Meanwhile, the actual number: TTM FCF −$42.4B, from +$14.8B a year ago. Capex is now 128% of operating cash flow. OCF grew and the company still burned cash.',
      '',
      'Filler sentence without any figure in it at all. '.repeat(10),
    ].join('\n')
    const out = excerptKeyPoints(text, { maxChars: 300 })
    expect(out.text).toBe([
      '3. The Q4 "capex step-down" is a definitional guess',
      '- Meanwhile, the actual number: TTM FCF −$42.4B, from +$14.8B a year ago. Capex is now 128% of operating cash flow.',
    ].join('\n'))
  })

  it('reads "No" before a noun as part of the point, and "No" before a dash as an answer', () => {
    const text = [
      '## Plan',
      '- No new capital below 250.72.',
      '',
      'Relative share loss is a weak thesis, some say. No — it is the only thesis that matters at 23x forward earnings.',
      '',
      'Filler sentence without any figure in it at all. '.repeat(10),
    ].join('\n')
    const out = excerptKeyPoints(text, { maxChars: 300 })
    expect(out.text).toContain('- No new capital below 250.72.')
    expect(out.text).toContain('- Relative share loss is a weak thesis, some say. No — it is the only thesis that matters at 23x forward earnings.')
  })

  it('opens a figure-free excerpt on the first sentence that stands on its own', () => {
    const prose = [
      'The bull says "the moat is wide and getting wider." But that is the wrong question.',
      'Returns on the new capital are unproven and management declined to state them.',
      'Nobody has shown the buildout earns its cost.',
      'Filler sentence without any figure in it at all. '.repeat(10),
    ].join(' ')
    const out = excerptKeyPoints(prose, { maxChars: 160, restates: RESTATES })
    expect(out.mode).toBe('head')
    expect(out.text).toBe('Returns on the new capital are unproven and management declined to state them. Nobody has shown the buildout earns its cost.')
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
