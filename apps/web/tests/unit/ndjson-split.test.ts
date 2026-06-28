import { describe, it, expect } from 'vitest'
import { splitNdjson } from '../../server/utils/ndjson'

describe('splitNdjson', () => {
  it('parses complete lines and buffers a partial trailing line', () => {
    const a = splitNdjson('', '{"type":"node-start","node":"market"}\n{"type":"node-st')
    expect(a.events).toEqual([{ type: 'node-start', node: 'market' }])
    expect(a.rest).toBe('{"type":"node-st')

    const b = splitNdjson(a.rest, 'art","node":"trader"}\n')
    expect(b.events).toEqual([{ type: 'node-start', node: 'trader' }])
    expect(b.rest).toBe('')
  })

  it('skips blank and malformed lines', () => {
    const r = splitNdjson('', '\n\nnot-json\n{"type":"run-end","run_id":"r","tokens_in":0,"tokens_out":0,"cost_usd":0}\n')
    expect(r.events).toHaveLength(1)
    expect((r.events[0] as { type: string }).type).toBe('run-end')
  })
})
