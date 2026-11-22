import { afterAll, describe, expect, it, vi } from 'vitest'
import type { MemoryWrite } from '../../server/lib/chat-memory-plan'
import { EVAL_ENABLED, RUNS, SCENARIO_TIMEOUT_MS, saveReport } from './support/harness'
import { MEMORY_TECH_KNOWN, MEMORY_USD_INTENTIONAL } from './support/owner-fixtures'

/**
 * Live eval of the memory extractor: the real `rememberFromTurn`, the default
 * `chat.memory` prompt and the quick model selected in Settings. The memory
 * store is replaced, so nothing is read from or written to the owner's saved
 * memories, and no usage row is recorded.
 *
 *   EVAL_LLM=1 DATABASE_URL=... ENCRYPTION_KEY=... npx vitest run tests/eval/chat-memory-extract
 */

const saved = new Map<string, string[]>()
const written = new Map<string, MemoryWrite[]>()

vi.mock('../../server/lib/chat-memory', () => ({
  listMemories: async (ownerId: string) =>
    (saved.get(ownerId) ?? []).map((content, i) => ({ id: `m${i + 1}`, content, source: 'auto', updatedAt: '2026-11-01T00:00:00.000Z' })),
  applyMemoryWrites: async (ownerId: string, writes: MemoryWrite[]) => {
    written.set(ownerId, writes)
  },
}))
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely: async () => {} }))
vi.mock('../../server/lib/prompts', async () => {
  const { webDefault } = await import('../../server/lib/prompts/registry')
  return { getPrompt: async (id: Parameters<typeof webDefault>[0]) => webDefault(id) }
})

const { rememberFromTurn } = await import('../../server/lib/chat-memory-extract')

const USD_NAG = 'All RM 2,000 goes to equity. Note your book is about 90% USD against a MYR base, so ringgit appreciation would be a drag in MYR terms; is that tilt intentional?'
const TECH_NAG = 'NVDA, MSFT, TSM and MU make up most of your equities, so the portfolio is heavily concentrated in tech and semiconductors.'

interface ExtractCase {
  id: string
  saved: string[]
  priorAssistantText: string
  userText: string
  /** True when the writes are what this message should save. */
  correct: (writes: MemoryWrite[]) => boolean
}

const inserts = (writes: MemoryWrite[]) => writes.filter(w => w.kind === 'insert')
const one = (writes: MemoryWrite[], kind: MemoryWrite['kind'], content: RegExp[]) =>
  writes.length === 1 && writes[0]?.kind === kind && content.every(re => re.test(writes[0]?.content ?? ''))

const CASES: ExtractCase[] = [
  {
    id: 'saves an intentional USD tilt',
    saved: [],
    priorAssistantText: USD_NAG,
    userText: 'yes the USD exposure is on purpose, stop flagging it',
    correct: w => one(w, 'insert', [/USD/, /intentional|on purpose|deliberate/i]),
  },
  {
    id: 'saves a known tech concentration',
    saved: [MEMORY_USD_INTENTIONAL],
    priorAssistantText: TECH_NAG,
    userText: 'I know I\'m tech heavy',
    correct: w => one(w, 'insert', [/tech/i, /know|aware|accept|intentional/i]),
  },
  {
    id: 'saves nothing from a question',
    saved: [MEMORY_USD_INTENTIONAL],
    priorAssistantText: '',
    userText: 'am I too heavy in tech?',
    correct: w => w.length === 0,
  },
  {
    id: 'saves nothing from a one-off request',
    saved: [MEMORY_USD_INTENTIONAL],
    priorAssistantText: '',
    userText: 'run a full analysis on MU and show me the daily chart for the last 60 days',
    correct: w => w.length === 0,
  },
  {
    id: 'saves nothing from a trade the owner just made',
    saved: [MEMORY_USD_INTENTIONAL],
    priorAssistantText: '',
    userText: 'I just bought 10 more NVDA at 171, what is my average cost now?',
    correct: w => w.length === 0,
  },
  {
    id: 'adds no duplicate of a saved memory',
    saved: [MEMORY_USD_INTENTIONAL, MEMORY_TECH_KNOWN],
    priorAssistantText: USD_NAG,
    userText: 'like I said, the USD tilt is deliberate',
    correct: w => inserts(w).length === 0,
  },
  {
    id: 'rewrites a memory the owner reverses',
    saved: [MEMORY_USD_INTENTIONAL, MEMORY_TECH_KNOWN],
    priorAssistantText: '',
    userText: 'Change of plan: I want tech under 50% of my equities by end of next year, so do flag it when a buy pushes tech higher.',
    correct: w => inserts(w).length === 0 && w.some(u => u.kind === 'update' && u.id === 'm2' && /50\s?%/.test(u.content)),
  },
]

const d = EVAL_ENABLED ? describe : describe.skip

d('memory extraction', () => {
  const results: Array<{ id: string, rate: string, outcomes: MemoryWrite[][] }> = []

  afterAll(() => {
    console.log(`\n[eval] chat-memory-extract: ${results.length * RUNS} quick-model requests`)
    for (const r of results) console.log(`[eval] ${r.id}: ${r.rate}`, JSON.stringify(r.outcomes))
    saveReport('chat-memory-extract', { suite: 'chat-memory-extract', runs: RUNS, results })
  })

  it.each(CASES)('$id', async (c) => {
    const outcomes: MemoryWrite[][] = []
    for (let run = 0; run < RUNS; run++) {
      const ownerId = `${c.id}#${run}`
      saved.set(ownerId, c.saved)
      await rememberFromTurn({ ownerId, userText: c.userText, priorAssistantText: c.priorAssistantText })
      outcomes.push(written.get(ownerId) ?? [])
    }
    const passes = outcomes.filter(c.correct).length
    results.push({ id: c.id, rate: `${passes}/${RUNS}`, outcomes })
    expect(passes, JSON.stringify(outcomes)).toBeGreaterThanOrEqual(Math.ceil((RUNS * 2) / 3))
  }, SCENARIO_TIMEOUT_MS)
})
