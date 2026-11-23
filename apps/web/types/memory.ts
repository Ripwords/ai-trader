import { z } from 'zod'

// Every saved memory goes into every chat turn's system prompt, so both caps
// bound the prompt: at most MEMORY_LIMIT × MEMORY_MAX_CHARS characters.
export const MEMORY_LIMIT = 30
export const MEMORY_MAX_CHARS = 240

export const memoryContentSchema = z.string()
  .transform(s => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string()
    .min(1, 'A memory cannot be empty.')
    .max(MEMORY_MAX_CHARS, `A memory can be at most ${MEMORY_MAX_CHARS} characters.`))

/** Who wrote the current text: the owner in Settings, or the extractor after a chat turn. */
export type MemorySource = 'manual' | 'auto'

export interface MemoryView {
  id: string
  content: string
  source: MemorySource
  updatedAt: string
}

export interface MemoryListResponse {
  memories: MemoryView[]
  limit: number
}
