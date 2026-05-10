import { defineEventHandler, readBody } from 'h3'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

interface StubBody {
  symbol: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<StubBody>(event)
  const sym = (body?.symbol ?? 'AAPL').toLowerCase()
  const path = resolve(process.cwd(), `tests/fixtures/agents-runs/${sym}-buy.ndjson`)
  const text = await readFile(path, 'utf8')
  const lines = text.split('\n').filter(l => l.trim())
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder()
      for (const line of lines) {
        controller.enqueue(enc.encode(line + '\n'))
        await new Promise(r => setTimeout(r, 80))
      }
      controller.close()
    },
  })
  event.node.res.setHeader('content-type', 'application/x-ndjson')
  event.node.res.setHeader('cache-control', 'no-store')
  return stream
})
