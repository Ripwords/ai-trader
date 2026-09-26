import { describe, expect, expectTypeOf, it } from 'vitest'
import { toolOutputOf, type ChatToolOutput } from '../../app/utils/chat-tool-output'
import type { KLineResponse } from '../../server/llm/http'

const kline = { code: 'US.NVDA', ktype: '1d', bars: [] }

describe('toolOutputOf', () => {
  it('returns the output of a finished call to the named tool', () => {
    const part = { type: 'tool-market_kline', toolCallId: 'c', state: 'output-available', input: {}, output: kline }
    expect(toolOutputOf(part, 'market_kline')).toBe(kline)
  })

  it('is undefined for another tool', () => {
    const part = { type: 'tool-search_news', toolCallId: 'c', state: 'output-available', input: {}, output: kline }
    expect(toolOutputOf(part, 'market_kline')).toBeUndefined()
  })

  it('is undefined before the output is available', () => {
    const part = { type: 'tool-market_kline', toolCallId: 'c', state: 'input-available', input: {} }
    expect(toolOutputOf(part, 'market_kline')).toBeUndefined()
  })

  it('reads dynamic tool parts by toolName', () => {
    const part = { type: 'dynamic-tool', toolName: 'market_kline', toolCallId: 'c', state: 'output-available', input: {}, output: kline }
    expect(toolOutputOf(part, 'market_kline')).toBe(kline)
  })

  it('is undefined for anything that is not a tool part', () => {
    expect(toolOutputOf({ type: 'text', text: 'hi' }, 'market_kline')).toBeUndefined()
    expect(toolOutputOf(null, 'market_kline')).toBeUndefined()
  })

  it('types the output from the server tool definitions', () => {
    expectTypeOf<ChatToolOutput<'market_kline'>>().toEqualTypeOf<KLineResponse>()
  })
})
