import { MEMORY_LIMIT, memoryContentSchema } from '../../types/memory'

/** What the extractor returns. `ref` is the 1-based number of the saved memory an update rewrites. */
export interface MemoryOperation {
  op: 'add' | 'update'
  ref: number | null
  content: string
}

export type MemoryWrite =
  | { kind: 'insert'; content: string }
  | { kind: 'update'; id: string; content: string }

/** Two memories are the same when they differ only in case or spacing. */
export function memoryKey(content: string): string {
  return content.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Turn the extractor's operations into writes that keep the list free of
 * repeats and within MEMORY_LIMIT. Anything that does not fit is dropped:
 * the next turn that mentions the fact gets another chance.
 */
export function planMemoryWrites(
  saved: ReadonlyArray<{ id: string; content: string }>,
  operations: readonly MemoryOperation[],
): MemoryWrite[] {
  const taken = new Set(saved.map(m => memoryKey(m.content)))
  let room = MEMORY_LIMIT - saved.length
  const writes: MemoryWrite[] = []
  for (const operation of operations) {
    const parsed = memoryContentSchema.safeParse(operation.content)
    if (!parsed.success) continue
    const content = parsed.data
    const key = memoryKey(content)
    if (taken.has(key)) continue
    if (operation.op === 'add') {
      if (room <= 0) continue
      room -= 1
      writes.push({ kind: 'insert', content })
    }
    else {
      const target = operation.ref === null ? undefined : saved[operation.ref - 1]
      if (!target) continue
      writes.push({ kind: 'update', id: target.id, content })
    }
    taken.add(key)
  }
  return writes
}
