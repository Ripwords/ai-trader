import { describe, expect, it } from 'vitest'
import {
  applyConversationMetadata,
  buildConversationSummary,
  extractMessageText,
  normalizeConversationMetadataMap,
  searchConversationThreads,
} from '../../server/lib/chat-management'

const threads = [
  { id: 'recent', title: 'Recent chat', createdAt: new Date('2026-05-14T00:00:00Z'), updatedAt: new Date('2026-05-14T10:00:00Z') },
  { id: 'pinned', title: 'Pinned plan', createdAt: new Date('2026-05-13T00:00:00Z'), updatedAt: new Date('2026-05-13T10:00:00Z') },
  { id: 'archived', title: 'Old idea', createdAt: new Date('2026-05-12T00:00:00Z'), updatedAt: new Date('2026-05-12T10:00:00Z') },
]

describe('chat management helpers', () => {
  it('normalizes metadata and drops malformed decision records', () => {
    expect(normalizeConversationMetadataMap({
      pinned: { pinned: true, decisions: [{ id: 'd1', title: 'Buy NVDA', created_at: '2026-05-16T00:00:00Z' }] },
      archived: { archived: true, summary: 'Old summary', decisions: [{ id: '', title: '', created_at: '' }] },
      bad: 'ignored',
    })).toEqual({
      pinned: {
        pinned: true,
        archived: false,
        summary: undefined,
        decisions: [{ id: 'd1', title: 'Buy NVDA', note: undefined, created_at: '2026-05-16T00:00:00Z' }],
      },
      archived: {
        pinned: false,
        archived: true,
        summary: 'Old summary',
        decisions: [],
      },
    })
  })

  it('orders pinned threads first and hides archived threads by default', () => {
    expect(applyConversationMetadata(threads, {
      pinned: { pinned: true, archived: false, decisions: [] },
      archived: { pinned: false, archived: true, decisions: [] },
    }).map(thread => thread.id)).toEqual(['pinned', 'recent'])

    expect(applyConversationMetadata(threads, {
      archived: { pinned: false, archived: true, decisions: [] },
    }, { includeArchived: true }).map(thread => thread.id)).toEqual(['recent', 'pinned', 'archived'])
  })

  it('extracts searchable text from UI message parts', () => {
    expect(extractMessageText({
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Review NVDA exposure.' },
        { type: 'tool-market_kline', output: { code: 'US.NVDA' } },
      ],
    })).toBe('Review NVDA exposure. {"code":"US.NVDA"}')
  })

  it('searches title, summary, decisions, and message snippets', () => {
    const managed = applyConversationMetadata(threads, {
      pinned: {
        pinned: true,
        archived: false,
        summary: 'Portfolio rebalance and NVDA concentration.',
        decisions: [{ id: 'd1', title: 'Trim NVDA', note: 'Reduce single-stock risk', created_at: '2026-05-16T00:00:00Z' }],
      },
    })

    expect(searchConversationThreads(managed, {
      pinned: [{ role: 'assistant', parts: [{ type: 'text', text: 'Use limit orders for trimming.' }] }],
      recent: [{ role: 'user', parts: [{ type: 'text', text: 'cashflow planning' }] }],
    }, 'limit orders')).toEqual([
      expect.objectContaining({
        id: 'pinned',
        match: expect.objectContaining({ source: 'message', snippet: 'Use limit orders for trimming.' }),
      }),
    ])
    expect(searchConversationThreads(managed, {}, 'trim nvda')).toEqual([
      expect.objectContaining({
        id: 'pinned',
        match: expect.objectContaining({ source: 'decision' }),
      }),
    ])
  })

  it('builds a compact summary and deterministic decision candidate from messages', () => {
    const summary = buildConversationSummary(threads[0], [
      { role: 'user', parts: [{ type: 'text', text: 'Should I buy NVDA after earnings?' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Decision: wait for a pullback and keep position size below 10%.' }] },
    ])

    expect(summary.summary).toContain('Should I buy NVDA after earnings?')
    expect(summary.decision?.title).toBe('wait for a pullback and keep position size below 10%.')
  })
})
