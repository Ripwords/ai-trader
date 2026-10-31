import { beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('keepThrough (TEST_DATABASE_URL)', () => {
  let repo: typeof import('../../server/db/repo')

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    repo = await import('../../server/db/repo')
  })

  const msg = (id: string, role: string) => ({ id, role, parts: [{ type: 'text', text: id }] })

  it('drops the failed reply a retry replaces, so a reload shows the question once and the new reply', async () => {
    const owner = await repo.getOwnerId()
    const thread = await repo.createThread(owner, 'retry test')
    try {
      await repo.appendMessages(thread, [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2-failed', 'assistant')])

      expect(await repo.keepThrough(thread, msg('u2', 'user'))).toBe(true)
      expect((await repo.getThreadMessages(thread)).map(m => m.id)).toEqual(['u1', 'a1', 'u2'])
    } finally {
      await repo.deleteThread(owner, thread)
    }
  })

  it('saves an edited question over the old one and drops every later turn, so a reload shows the edit and its new reply', async () => {
    const owner = await repo.getOwnerId()
    const thread = await repo.createThread(owner, 'edit test')
    try {
      await repo.appendMessages(thread, [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')])

      const edited = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'edited question' }] }
      expect(await repo.keepThrough(thread, edited)).toBe(true)
      expect(await repo.getThreadMessages(thread)).toEqual([edited])
    } finally {
      await repo.deleteThread(owner, thread)
    }
  })

  it('leaves the thread alone for a question it has not saved yet', async () => {
    const owner = await repo.getOwnerId()
    const thread = await repo.createThread(owner, 'retry test')
    try {
      await repo.appendMessages(thread, [msg('u1', 'user'), msg('a1', 'assistant')])

      expect(await repo.keepThrough(thread, msg('u-new', 'user'))).toBe(false)
      expect((await repo.getThreadMessages(thread)).map(m => m.id)).toEqual(['u1', 'a1'])
    } finally {
      await repo.deleteThread(owner, thread)
    }
  })
})
