import { describe, expect, it } from 'vitest'
import { appSettings, chatMessages, chatThreads, users } from '../../db/schema'

describe('schema', () => {
  it('has the four expected tables', () => {
    expect(users[Symbol.for('drizzle:Name')]).toBe('users')
    expect(appSettings[Symbol.for('drizzle:Name')]).toBe('app_settings')
    expect(chatThreads[Symbol.for('drizzle:Name')]).toBe('chat_threads')
    expect(chatMessages[Symbol.for('drizzle:Name')]).toBe('chat_messages')
  })
})
