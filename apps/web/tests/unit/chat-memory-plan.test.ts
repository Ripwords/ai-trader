import { describe, expect, it } from 'vitest'
import { MEMORY_LIMIT, MEMORY_MAX_CHARS, memoryContentSchema } from '../../types/memory'
import { planMemoryWrites } from '../../server/lib/chat-memory-plan'

const saved = [
  { id: 'a', content: 'The owner holds mostly USD assets against a MYR base; this is intentional.' },
  { id: 'b', content: 'The owner knows the book is tech-heavy and accepts the concentration.' },
]

describe('memoryContentSchema', () => {
  it('collapses whitespace and rejects empty or overlong text', () => {
    expect(memoryContentSchema.parse('  mostly   USD\n on purpose ')).toBe('mostly USD on purpose')
    expect(memoryContentSchema.safeParse('   ').success).toBe(false)
    expect(memoryContentSchema.safeParse('x'.repeat(MEMORY_MAX_CHARS + 1)).success).toBe(false)
    expect(memoryContentSchema.safeParse('x'.repeat(MEMORY_MAX_CHARS)).success).toBe(true)
  })
})

describe('planMemoryWrites', () => {
  it('inserts a new fact', () => {
    expect(planMemoryWrites(saved, [{ op: 'add', ref: null, content: 'The owner invests for retirement in 2045.' }]))
      .toEqual([{ kind: 'insert', content: 'The owner invests for retirement in 2045.' }])
  })

  it('drops an add that repeats a saved memory, whatever its case or spacing', () => {
    expect(planMemoryWrites(saved, [{ op: 'add', ref: null, content: '  the owner knows the book is  TECH-heavy and accepts the concentration. ' }]))
      .toEqual([])
  })

  it('drops the second of two identical adds in one batch', () => {
    const op = { op: 'add' as const, ref: null, content: 'The owner never trades options.' }
    expect(planMemoryWrites(saved, [op, op])).toHaveLength(1)
  })

  it('rewrites the memory an update points at by its 1-based number', () => {
    expect(planMemoryWrites(saved, [{ op: 'update', ref: 2, content: 'The owner now wants to cut tech below 50% of the book.' }]))
      .toEqual([{ kind: 'update', id: 'b', content: 'The owner now wants to cut tech below 50% of the book.' }])
  })

  it('drops an update with no number, an unknown number, or unchanged text', () => {
    expect(planMemoryWrites(saved, [
      { op: 'update', ref: null, content: 'x' },
      { op: 'update', ref: 3, content: 'x' },
      { op: 'update', ref: 0, content: 'x' },
      { op: 'update', ref: 1, content: saved[0]!.content },
    ])).toEqual([])
  })

  it('drops empty and overlong text instead of saving a cut-off sentence', () => {
    expect(planMemoryWrites(saved, [
      { op: 'add', ref: null, content: '   ' },
      { op: 'add', ref: null, content: 'x'.repeat(MEMORY_MAX_CHARS + 1) },
    ])).toEqual([])
  })

  it('stops adding at the limit but still updates', () => {
    const full = Array.from({ length: MEMORY_LIMIT }, (_, i) => ({ id: `m${i}`, content: `fact ${i}` }))
    expect(planMemoryWrites(full, [
      { op: 'add', ref: null, content: 'one too many' },
      { op: 'update', ref: 1, content: 'fact zero, revised' },
    ])).toEqual([{ kind: 'update', id: 'm0', content: 'fact zero, revised' }])
  })

  it('fills only the room that is left', () => {
    const nearly = Array.from({ length: MEMORY_LIMIT - 1 }, (_, i) => ({ id: `m${i}`, content: `fact ${i}` }))
    const writes = planMemoryWrites(nearly, [
      { op: 'add', ref: null, content: 'first new' },
      { op: 'add', ref: null, content: 'second new' },
    ])
    expect(writes).toEqual([{ kind: 'insert', content: 'first new' }])
  })
})
