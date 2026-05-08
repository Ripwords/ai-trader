import { describe, expect, it } from 'vitest'
import {
  algoRuns,
  algoStrategies,
  appSettings,
  chatMessages,
  chatThreads,
  users,
} from '../../db/schema'

const NAME = Symbol.for('drizzle:Name')
const COLS = Symbol.for('drizzle:Columns')

describe('schema', () => {
  it('has the expected core tables', () => {
    expect((users as unknown as Record<symbol, string>)[NAME]).toBe('users')
    expect((appSettings as unknown as Record<symbol, string>)[NAME]).toBe('app_settings')
    expect((chatThreads as unknown as Record<symbol, string>)[NAME]).toBe('chat_threads')
    expect((chatMessages as unknown as Record<symbol, string>)[NAME]).toBe('chat_messages')
  })

  it('algoStrategies has the new backtest config columns and dropped qty_per_signal', () => {
    const cols = (algoStrategies as unknown as Record<symbol, Record<string, unknown>>)[COLS]
    expect(Object.keys(cols)).toEqual(expect.arrayContaining([
      'initialCapital', 'commissionBps', 'slippageBps',
      'sizingMode', 'sizingValue', 'pyramidingMax',
    ]))
    expect(Object.keys(cols)).not.toContain('qtyPerSignal')
  })

  it('algoRuns has the new benchmark and price_bars columns', () => {
    const cols = (algoRuns as unknown as Record<symbol, Record<string, unknown>>)[COLS]
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['benchmarkCurve', 'priceBars']))
  })
})
