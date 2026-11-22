import { describe, it, expect } from 'vitest'
import { extractTickerCandidates, formatRecallLine, matchResearchedSymbols } from '../../server/llm/recall'

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

describe('matchResearchedSymbols', () => {
  const researched = [
    { symbol: 'US.AMZN', companyName: 'Amazon.com, Inc.' },
    { symbol: 'US.NVDA', companyName: 'NVIDIA Corporation' },
    { symbol: 'US.META', companyName: 'Meta Platforms, Inc.' },
    { symbol: 'US.NOW', companyName: 'ServiceNow, Inc.' },
    { symbol: 'US.MU', companyName: null },
    { symbol: 'US.TGT', companyName: 'Target Corporation' },
  ]
  const match = (text: string) => matchResearchedSymbols(text, researched)

  it('matches a ticker however it is cased', () => {
    expect(match('should I trim NVDA?')).toEqual(['US.NVDA'])
    expect(match('should i buy nvda today')).toEqual(['US.NVDA'])
    expect(match('what about $amzn')).toEqual(['US.AMZN'])
    expect(match('pull up us.amzn')).toEqual(['US.AMZN'])
  })

  it('matches the company by name', () => {
    expect(match('is amazon still a hold?')).toEqual(['US.AMZN'])
    expect(match('thoughts on Nvidia vs Meta')).toEqual(['US.NVDA', 'US.META'])
    expect(match('how is ServiceNow doing')).toEqual(['US.NOW'])
  })

  it('only matches a ticker that is also an everyday word when it is written as a ticker', () => {
    expect(match('what should I do now')).toEqual([])
    expect(match('is NOW a buy')).toEqual(['US.NOW'])
    expect(match('is $now a buy')).toEqual(['US.NOW'])
    expect(match('what is your price target')).toEqual([])
    expect(match('mu is cheap')).toEqual([])
    expect(match('MU is cheap')).toEqual(['US.MU'])
  })

  it('does not match inside a longer word or symbol', () => {
    expect(match('the metaverse, amazonian margins and NVDAX')).toEqual([])
  })

  it('ignores symbols the user has not researched', () => {
    expect(match('should I buy TSLA or tesla')).toEqual([])
  })

  it('orders by first mention, once each, capped', () => {
    expect(match('meta, then amazon, then meta again and NVDA')).toEqual(['US.META', 'US.AMZN', 'US.NVDA'])
    expect(matchResearchedSymbols('meta amazon nvda MU', researched, 2)).toEqual(['US.META', 'US.AMZN'])
  })
})

describe('formatRecallLine', () => {
  const now = Date.parse('2026-06-28T12:00:00Z')
  const run = {
    runId: 'abcdef1234', symbol: 'US.NVDA', status: 'complete',
    finishedAt: '2026-06-28T10:00:00Z', rating: 'buy', confidence: 72, originalRating: null,
  }

  it('gives the rating, what the confidence measures, the age and the full run id', () => {
    expect(formatRecallLine(run, now))
      .toBe('US.NVDA — research 2h ago: buy, 72% 7-trading-day probability (run abcdef1234)')
  })

  it('says when the valuation capped the rating', () => {
    expect(formatRecallLine({ ...run, rating: 'hold', originalRating: 'buy' }, now))
      .toContain('hold (valuation capped it from buy), 72% 7-trading-day probability')
  })

  it('says when there is no confidence score', () => {
    expect(formatRecallLine({ ...run, confidence: null }, now)).toContain('buy, no confidence score')
  })

  it('gives the status of a run without a verdict', () => {
    expect(formatRecallLine({ ...run, status: 'failed', rating: null, confidence: null }, now))
      .toBe('US.NVDA — research 2h ago: failed (run abcdef1234)')
  })
})
