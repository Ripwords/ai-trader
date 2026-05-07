import { z } from 'zod'
import { getAgent } from '../mastra/agent'

const Body = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ),
})

/**
 * POST /api/chat
 *
 * Accepts { messages: [{role, content}] } and returns a streaming response
 * in newline-delimited JSON (NDJSON) format.
 *
 * Each line is a JSON object with the shape:
 *   { type: 'text-delta',   payload: { text: '...' } }
 *   { type: 'tool-call',    payload: { toolCallId, toolName, args } }
 *   { type: 'tool-result',  payload: { toolCallId, toolName, result } }
 *   { type: 'finish',       payload: { finishReason } }
 *   { type: 'error',        payload: { message } }
 *
 * Task 12 should read the response body as a stream, split on '\n',
 * JSON.parse each non-empty line, and dispatch on `type`.
 */
export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const agent = getAgent()

  // agent.stream returns Promise<MastraModelOutput>
  // fullStream is a ReadableStream<ChunkType> with Mastra's typed chunk format
  const output = await agent.stream(body.messages, { maxSteps: 6 })
  const { fullStream } = output

  setResponseHeader(event, 'Content-Type', 'application/x-ndjson')
  setResponseHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setResponseHeader(event, 'X-Accel-Buffering', 'no')

  // Return a web-standard ReadableStream of NDJSON lines.
  // Each Mastra chunk is mapped to a JSON object; irrelevant chunk types are dropped.
  const ndjsonStream = fullStream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        // chunk is a Mastra ChunkType (tagged union on `type`)
        const c = chunk as { type: string; payload?: unknown }

        let line: string | null = null

        switch (c.type) {
          case 'text-delta': {
            const payload = c.payload as { text?: string }
            line = JSON.stringify({ type: 'text-delta', payload: { text: payload?.text ?? '' } })
            break
          }
          case 'tool-call': {
            const payload = c.payload as { toolCallId?: string; toolName?: string; args?: unknown }
            line = JSON.stringify({
              type: 'tool-call',
              payload: {
                toolCallId: payload?.toolCallId,
                toolName: payload?.toolName,
                args: payload?.args,
              },
            })
            break
          }
          case 'tool-result': {
            const payload = c.payload as { toolCallId?: string; toolName?: string; result?: unknown }
            line = JSON.stringify({
              type: 'tool-result',
              payload: {
                toolCallId: payload?.toolCallId,
                toolName: payload?.toolName,
                result: payload?.result,
              },
            })
            break
          }
          case 'finish': {
            const payload = c.payload as { finishReason?: string }
            line = JSON.stringify({ type: 'finish', payload: { finishReason: payload?.finishReason } })
            break
          }
          case 'error': {
            const payload = c.payload as { error?: { message?: string }; message?: string }
            const message =
              (payload as { error?: { message?: string } })?.error?.message ??
              (payload as { message?: string })?.message ??
              'Unknown error'
            line = JSON.stringify({ type: 'error', payload: { message } })
            break
          }
          default:
            // Skip: step-start, step-finish, response-metadata, text-start, text-end, etc.
            break
        }

        if (line !== null) {
          controller.enqueue(new TextEncoder().encode(line + '\n'))
        }
      },
    }),
  )

  return sendStream(event, ndjsonStream)
})
