import { defineEventHandler, readBody } from 'h3'
import { AgentRunTee } from '../../utils/agents-tee'
import { splitNdjson } from '../../utils/ndjson'
import { startAgentRun, type AgentsRunBody } from '../../lib/agents/start-run'

export default defineEventHandler(async (event) => {
  const body = await readBody<AgentsRunBody>(event)
  const { run, userId, upstream } = await startAgentRun(body)

  const tee = new AgentRunTee(run.id, userId)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let teeBuf = ''
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        const tail = splitNdjson(teeBuf, '\n')
        for (const ev of tail.events) tee.push(ev)
        controller.close()
        return
      }
      controller.enqueue(value)
      const { events, rest } = splitNdjson(teeBuf, decoder.decode(value, { stream: true }))
      teeBuf = rest
      for (const ev of events) tee.push(ev)
    },
    cancel() {
      void reader.cancel()
    },
  })

  event.node.res.setHeader('content-type', 'application/x-ndjson')
  event.node.res.setHeader('cache-control', 'no-store')
  return stream
})
