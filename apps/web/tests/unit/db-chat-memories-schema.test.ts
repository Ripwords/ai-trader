import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { chatMemories } from '../../db/schema'

describe('chat_memories schema', () => {
  it('stores one fact per row, owned by a user, with who wrote it last', () => {
    expect(getTableName(chatMemories)).toBe('chat_memories')
    const cols = getTableColumns(chatMemories)
    expect(Object.keys(cols)).toEqual(['id', 'userId', 'content', 'source', 'createdAt', 'updatedAt'])
    expect(cols.userId.notNull).toBe(true)
    expect(cols.content.notNull).toBe(true)
    expect(cols.source.notNull).toBe(true)
    expect(cols.updatedAt.withTimezone).toBe(true)
  })

  it('has a migration that creates the table and removes memories with their owner', () => {
    const sql = readFileSync(fileURLToPath(new URL('../../db/migrations/0011_chat_memories.sql', import.meta.url)), 'utf8')
    expect(sql).toContain('CREATE TABLE "chat_memories"')
    expect(sql).toMatch(/FOREIGN KEY \("user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/)
  })
})
