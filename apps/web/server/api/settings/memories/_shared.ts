import type { H3Event } from 'h3'
import { createError, readBody } from 'h3'
import { z } from 'zod'
import { MEMORY_LIMIT, memoryContentSchema, type MemoryView } from '../../../../types/memory'
import type { MemoryWriteResult } from '../../../lib/chat-memory'

const bodySchema = z.object({ content: memoryContentSchema })

export async function memoryContent(event: H3Event): Promise<string> {
  const body = bodySchema.safeParse(await readBody(event))
  if (!body.success) {
    throw createError({ statusCode: 400, statusMessage: body.error.issues[0]?.message ?? 'Body must be { content: string }.' })
  }
  return body.data.content
}

const REFUSALS = {
  full: { statusCode: 409, statusMessage: `Memory is full (${MEMORY_LIMIT}). Delete or edit one first.` },
  duplicate: { statusCode: 409, statusMessage: 'That memory is already saved.' },
  not_found: { statusCode: 404, statusMessage: 'Memory not found.' },
} as const

export function memoryOrThrow(result: MemoryWriteResult): { memory: MemoryView } {
  if ('error' in result) throw createError(REFUSALS[result.error])
  return result
}
