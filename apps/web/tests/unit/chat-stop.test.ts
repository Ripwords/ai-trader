import { describe, expect, it } from 'vitest'
import type { ToolSet, UIMessage } from 'ai'
import { settleStoppedParts, stopOnAbort } from '../../server/llm/chat-stop'

const never = () => new Promise<never>(() => {})
const options = (abortSignal: AbortSignal) => ({ toolCallId: 't1', messages: [], abortSignal })

describe('stopOnAbort', () => {
  it('fails a running read tool with "Stopped" as soon as Stop is pressed', async () => {
    const ctl = new AbortController()
    const tools = stopOnAbort({ market_snapshot: { inputSchema: {} as never, execute: never } } as ToolSet)
    const run = tools.market_snapshot!.execute!({}, options(ctl.signal))
    ctl.abort()
    await expect(run).rejects.toThrow(/^Stopped$/)
  })

  it('says an order that was mid-flight may still have gone through, since Stop cannot recall a request already sent to the broker', async () => {
    const ctl = new AbortController()
    const tools = stopOnAbort({ trade_place_order: { inputSchema: {} as never, execute: never } } as ToolSet)
    const run = tools.trade_place_order!.execute!({}, options(ctl.signal))
    ctl.abort()
    await expect(run).rejects.toThrow(/may still have gone through.*trade_orders/)
  })
})

describe('settleStoppedParts', () => {
  const part = (type: string, state = 'input-available'): UIMessage['parts'][number] =>
    ({ type, toolCallId: 'c1', state, input: {} }) as UIMessage['parts'][number]

  it('closes an open read-tool call as Stopped', () => {
    const [p] = settleStoppedParts([part('tool-market_kline')])
    expect(p).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
  })

  it('does not tell the user an open order call was stopped when it may have been placed', () => {
    const [p] = settleStoppedParts([part('tool-trade_cancel_order')])
    expect(p).toMatchObject({ state: 'output-error' })
    expect((p as { errorText: string }).errorText).toMatch(/may still have gone through/)
  })

  it('says plain Stopped for an order call whose input was still streaming, since it never ran', () => {
    const [p] = settleStoppedParts([part('tool-trade_place_order', 'input-streaming')])
    expect(p).toMatchObject({ state: 'output-error', errorText: 'Stopped' })
  })
})
