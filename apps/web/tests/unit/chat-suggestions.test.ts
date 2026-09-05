import { describe, expect, it } from 'vitest'
import {
  buildSuggestions,
  DEFAULT_SUGGESTIONS,
  SUGGESTION_COUNT,
  type SuggestionSources,
} from '../../server/lib/chat-suggestions'

const empty: SuggestionSources = { watchlist: [], positions: [], triggeredAlerts: [] }

// Deterministic rng: always picks the first candidate.
const first = () => 0
// Always picks the last candidate.
const last = () => 0.999999

describe('buildSuggestions', () => {
  it('falls back to the static defaults when every source is empty', () => {
    expect(buildSuggestions(empty, first)).toEqual(DEFAULT_SUGGESTIONS)
    expect(DEFAULT_SUGGESTIONS).toHaveLength(SUGGESTION_COUNT)
  })

  it('charts a watchlist symbol instead of the hardcoded NVDA', () => {
    const out = buildSuggestions({ ...empty, watchlist: [{ code: 'HK.00700', name: 'Tencent' }] }, first)
    expect(out).toContain('Show me HK.00700 daily')
    expect(out).not.toContain('Show me NVDA daily')
  })

  it('asks for news by company name when one is known', () => {
    const out = buildSuggestions({
      ...empty,
      watchlist: [{ code: 'US.AAPL', name: 'Apple' }, { code: 'US.ANET', name: 'Arista Networks' }],
    }, first)
    expect(out).toContain('Any news on Arista Networks?')
  })

  it('asks for news by code when no name is known', () => {
    const out = buildSuggestions({
      ...empty,
      watchlist: [{ code: 'US.AAPL', name: null }, { code: 'US.ANET', name: null }],
    }, first)
    expect(out).toContain('Any news on US.ANET?')
  })

  it('never uses the same symbol in two slots when others are available', () => {
    const out = buildSuggestions({
      ...empty,
      watchlist: [{ code: 'US.AAPL', name: 'Apple' }, { code: 'US.MSFT', name: 'Microsoft' }],
    }, first)
    expect(out).toContain('Show me US.AAPL daily')
    expect(out).toContain('Any news on Microsoft?')
  })

  it('treats a bare tracker ticker and its moomoo code as one symbol', () => {
    const out = buildSuggestions({
      ...empty,
      watchlist: [{ code: 'US.AAPL', name: null }, { code: 'MY.1066', name: null }, { code: 'US.MSFT', name: null }],
      positions: [
        { symbol: 'AAPL', name: 'Apple Inc.', pnlPct: 70},
        { symbol: '1066.KL', name: 'RHB Bank Berhad', pnlPct: 10},
      ],
    }, first)
    expect(out).toContain('How is my US.AAPL position doing?')
    expect(out).toContain('Show me MY.1066 daily')
    expect(out).toContain('Any news on US.MSFT?')
    expect(out.filter(s => s.includes('AAPL') || s.includes('Apple'))).toHaveLength(1)
    expect(out.filter(s => s.includes('1066'))).toHaveLength(1)
  })

  it('merges a zero-padded HK code with its bare tracker ticker', () => {
    const out = buildSuggestions({
      ...empty,
      watchlist: [{ code: 'HK.00700', name: null }],
      positions: [{ symbol: '0700.HK', name: 'Tencent', pnlPct: 12 }],
    }, first)
    expect(out).toContain('How is my HK.00700 position doing?')
    expect(out.filter(s => s.includes('0700') || s.includes('Tencent'))).toHaveLength(1)
  })

  it('mentions a lone symbol once and fills the rest with evergreen prompts', () => {
    const out = buildSuggestions({ ...empty, watchlist: [{ code: 'US.NVDA', name: 'NVIDIA' }] }, first)
    expect(out).toHaveLength(SUGGESTION_COUNT)
    expect(out.filter(s => s.includes('NVDA') || s.includes('NVIDIA'))).toHaveLength(1)
  })

  it('surfaces the biggest mover among held positions', () => {
    const out = buildSuggestions({
      ...empty,
      positions: [
        { symbol: 'US.TSLA', name: 'Tesla', pnlPct: 2},
        { symbol: 'US.AMD', name: 'AMD', pnlPct: -18.5},
      ],
    }, first)
    expect(out).toContain('How is my US.AMD position doing?')
  })

  it('surfaces a triggered alert ahead of a position', () => {
    const out = buildSuggestions({
      ...empty,
      positions: [{ symbol: 'US.AMD', name: 'AMD', pnlPct: -18.5}],
      triggeredAlerts: [{ symbol: 'US.NVDA' }],
    }, first)
    expect(out).toContain('What happened with my US.NVDA alert?')
    expect(out).not.toContain('How is my US.AMD position doing?')
  })

  it('always returns exactly four unique suggestions', () => {
    const sources: SuggestionSources = {
      watchlist: [{ code: 'US.AAPL', name: 'Apple' }],
      positions: [{ symbol: 'US.AAPL', name: 'Apple', pnlPct: 5}],
      triggeredAlerts: [{ symbol: 'US.AAPL' }],
    }
    for (const rng of [first, last, Math.random]) {
      const out = buildSuggestions(sources, rng)
      expect(out).toHaveLength(SUGGESTION_COUNT)
      expect(new Set(out).size).toBe(SUGGESTION_COUNT)
    }
  })

  it('rotates with the rng so a new chat gets a different mix', () => {
    const sources: SuggestionSources = {
      ...empty,
      watchlist: [{ code: 'US.AAPL', name: 'Apple' }, { code: 'US.MSFT', name: 'Microsoft' }, { code: 'US.GOOG', name: 'Alphabet' }],
    }
    expect(buildSuggestions(sources, first)).not.toEqual(buildSuggestions(sources, last))
  })
})
