import { describe, it, expect } from 'vitest'
import { extractTickerCandidates, formatRecallLine } from '../../server/llm/recall'

describe('extractTickerCandidates', () => {
  it('finds bare uppercase tickers', () => {
    expect(extractTickerCandidates('should I trim NVDA?')).toEqual(['NVDA'])
  })
  it('finds cashtags case-insensitively and uppercases them', () => {
    expect(extractTickerCandidates('compare $nvda and $Tsla')).toEqual(['NVDA', 'TSLA'])
  })
  it('drops common stopwords and 1-letter words', () => {
    expect(extractTickerCandidates('A I OK THE AND BUY NVDA')).toEqual(['NVDA'])
  })
  it('ignores lowercase bare words (avoids false positives)', () => {
    expect(extractTickerCandidates('should i buy aapl today')).toEqual([])
  })
  it('dedupes and caps at max', () => {
    expect(extractTickerCandidates('NVDA NVDA TSLA AMD MU AAPL GOOG', 3)).toEqual(['NVDA', 'TSLA', 'AMD'])
  })
})

describe('formatRecallLine', () => {
  it('formats a completed run with age, rating and confidence', () => {
    const now = Date.parse('2026-06-28T12:00:00Z')
    const line = formatRecallLine(
      { runId: 'abcdef1234', symbol: 'NVDA', status: 'complete',
        finishedAt: '2026-06-28T10:00:00Z', rating: 'BUY', confidence: 72 },
      now,
    )
    expect(line).toContain('NVDA')
    expect(line).toContain('BUY')
    expect(line).toContain('conf 72')
    expect(line).toContain('2h ago')
    expect(line).toContain('abcdef12') // short run id for research_get
  })
})
