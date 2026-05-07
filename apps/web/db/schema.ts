import { jsonb, pgTable, serial, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const appSettings = pgTable('app_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => chatThreads.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).notNull(),
  content: jsonb('content').notNull(),
  toolCalls: jsonb('tool_calls'),
  reasoning: jsonb('reasoning'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
