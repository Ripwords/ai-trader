import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { MEMORY_LIMIT } from '../../types/memory'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('chat memory store (TEST_DATABASE_URL)', () => {
  let memory: typeof import('../../server/lib/chat-memory')
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let owner: string
  let other: string

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    memory = await import('../../server/lib/chat-memory')
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    const made = await db.insert(schema.users).values([{ name: 'memory-test-a' }, { name: 'memory-test-b' }]).returning({ id: schema.users.id })
    owner = made[0]!.id
    other = made[1]!.id
    return async () => {
      await db.delete(schema.users).where(eq(schema.users.id, owner))
      await db.delete(schema.users).where(eq(schema.users.id, other))
    }
  })

  afterEach(async () => {
    await db.delete(schema.chatMemories)
  })

  it('adds a memory and lists it oldest first, for its owner only', async () => {
    const first = await memory.addMemory(owner, 'USD exposure is intentional.', 'manual')
    const second = await memory.addMemory(owner, 'Tech concentration is acknowledged.', 'manual')
    await memory.addMemory(other, 'Someone else.', 'manual')
    expect(first).toMatchObject({ memory: { content: 'USD exposure is intentional.', source: 'manual' } })
    expect(second).toHaveProperty('memory')
    const listed = await memory.listMemories(owner)
    expect(listed.map(m => m.content)).toEqual(['USD exposure is intentional.', 'Tech concentration is acknowledged.'])
    expect(typeof listed[0]!.updatedAt).toBe('string')
  })

  it('refuses a duplicate and a memory past the limit, saying which', async () => {
    await memory.addMemory(owner, 'USD exposure is intentional.', 'manual')
    await expect(memory.addMemory(owner, 'usd  exposure is INTENTIONAL.', 'manual')).resolves.toEqual({ error: 'duplicate' })
    await db.insert(schema.chatMemories).values(
      Array.from({ length: MEMORY_LIMIT - 1 }, (_, i) => ({ userId: owner, content: `fact ${i}`, source: 'manual' })),
    )
    await expect(memory.addMemory(owner, 'one too many', 'manual')).resolves.toEqual({ error: 'full' })
  })

  it('edits and deletes only the owner\'s own memory', async () => {
    const added = await memory.addMemory(owner, 'USD exposure is intentional.', 'auto')
    if (!('memory' in added)) throw new Error('add failed')
    const { id } = added.memory

    await expect(memory.updateMemory(other, id, 'hijacked', 'manual')).resolves.toEqual({ error: 'not_found' })
    await expect(memory.updateMemory(owner, id, 'USD exposure is intentional and long-term.', 'manual'))
      .resolves.toMatchObject({ memory: { id, content: 'USD exposure is intentional and long-term.', source: 'manual' } })

    await expect(memory.deleteMemory(other, id)).resolves.toBe(false)
    await expect(memory.deleteMemory(owner, id)).resolves.toBe(true)
    await expect(memory.listMemories(owner)).resolves.toEqual([])
  })

  it('treats an id that is not a uuid as not found, rather than a database error', async () => {
    await expect(memory.updateMemory(owner, 'nope', 'x', 'manual')).resolves.toEqual({ error: 'not_found' })
    await expect(memory.deleteMemory(owner, 'nope')).resolves.toBe(false)
  })

  it('refuses an edit that would duplicate another memory', async () => {
    await memory.addMemory(owner, 'First fact.', 'manual')
    const second = await memory.addMemory(owner, 'Second fact.', 'manual')
    if (!('memory' in second)) throw new Error('add failed')
    await expect(memory.updateMemory(owner, second.memory.id, 'first fact.', 'manual')).resolves.toEqual({ error: 'duplicate' })
  })

  it('applies the extractor\'s writes and marks them as learned from chat', async () => {
    const added = await memory.addMemory(owner, 'USD exposure is intentional.', 'manual')
    if (!('memory' in added)) throw new Error('add failed')
    await memory.applyMemoryWrites(owner, [
      { kind: 'update', id: added.memory.id, content: 'USD exposure is intentional; target 70%.' },
      { kind: 'insert', content: 'Never trades options.' },
    ], 'auto')
    const listed = await memory.listMemories(owner)
    expect(listed.map(m => [m.content, m.source])).toEqual([
      ['USD exposure is intentional; target 70%.', 'auto'],
      ['Never trades options.', 'auto'],
    ])
  })
})
