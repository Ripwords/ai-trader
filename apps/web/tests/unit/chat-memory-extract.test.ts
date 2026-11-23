import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryWrite } from '../../server/lib/chat-memory-plan'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: generateObjectMock }))
const resolveModelMock = vi.fn(async () => ({ model: {}, spec: 'mock/quick', providerKind: 'openai', modelId: 'quick' }))
vi.mock('../../server/llm/model', () => ({ resolveModel: resolveModelMock }))
const recordUsageSafely = vi.fn()
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely }))
vi.mock('../../server/lib/prompts/store', () => ({ readPromptOverrides: async () => ({}) }))

const store = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; content: string }>,
  listMemories: vi.fn(),
  applyMemoryWrites: vi.fn(),
}))
vi.mock('../../server/lib/chat-memory', () => ({
  listMemories: store.listMemories,
  applyMemoryWrites: store.applyMemoryWrites,
}))

const { rememberFromTurn } = await import('../../server/lib/chat-memory-extract')

const USD = 'The owner holds mostly USD assets against a MYR base; this is intentional.'
const answer = (operations: Array<{ op: 'add' | 'update'; ref: number | null; content: string }>) =>
  ({ object: { operations }, usage: { inputTokens: 300, outputTokens: 20 } })

beforeEach(() => {
  generateObjectMock.mockReset()
  recordUsageSafely.mockClear()
  resolveModelMock.mockClear()
  store.rows = []
  store.listMemories.mockReset().mockImplementation(async () => store.rows.map(r => ({ ...r })))
  store.applyMemoryWrites.mockReset().mockImplementation(async (_owner: string, writes: MemoryWrite[]) => {
    for (const w of writes) {
      if (w.kind === 'insert') store.rows.push({ id: `m${store.rows.length + 1}`, content: w.content })
      else store.rows.find(r => r.id === w.id)!.content = w.content
    }
  })
})

describe('rememberFromTurn', () => {
  it('saves a durable fact from the owner\'s message with the quick model, and records the cost', async () => {
    generateObjectMock.mockResolvedValue(answer([{ op: 'add', ref: null, content: USD }]))
    await rememberFromTurn({ ownerId: 'u1', userText: 'my usd exposure is on purpose, stop warning me', priorAssistantText: '' })
    expect(resolveModelMock).toHaveBeenCalledWith('quick')
    expect(store.applyMemoryWrites).toHaveBeenCalledWith('u1', [{ kind: 'insert', content: USD }], 'auto')
    expect(recordUsageSafely).toHaveBeenCalledWith(expect.objectContaining({ source: 'chat-memory', inputTokens: 300, outputTokens: 20 }))
  })

  it('shows the model the saved memories by number and marks the assistant text as context only', async () => {
    store.rows = [{ id: 'a', content: USD }]
    generateObjectMock.mockResolvedValue(answer([]))
    await rememberFromTurn({ ownerId: 'u1', userText: 'yes that is intentional', priorAssistantText: 'Your book is 80% tech. Is that intended?' })
    const prompt: string = generateObjectMock.mock.calls[0]![0].prompt
    expect(prompt).toContain(`1. ${USD}`)
    expect(prompt).toContain('yes that is intentional')
    expect(prompt).toMatch(/context only[^]*Your book is 80% tech/i)
    expect(prompt.indexOf('Your book is 80% tech')).toBeLessThan(prompt.indexOf('yes that is intentional'))
    expect(store.applyMemoryWrites).not.toHaveBeenCalled()
  })

  it('updates the numbered memory instead of adding a near-duplicate', async () => {
    store.rows = [{ id: 'a', content: USD }]
    generateObjectMock.mockResolvedValue(answer([{ op: 'update', ref: 1, content: 'The owner now wants USD under 60% of the book.' }]))
    await rememberFromTurn({ ownerId: 'u1', userText: 'actually I want usd under 60% now', priorAssistantText: '' })
    expect(store.applyMemoryWrites).toHaveBeenCalledWith('u1', [{ kind: 'update', id: 'a', content: 'The owner now wants USD under 60% of the book.' }], 'auto')
  })

  it('does not call a model for an empty message or a slash command', async () => {
    await rememberFromTurn({ ownerId: 'u1', userText: '   ', priorAssistantText: '' })
    await rememberFromTurn({ ownerId: 'u1', userText: '/research NVDA', priorAssistantText: '' })
    expect(generateObjectMock).not.toHaveBeenCalled()
  })

  it('bounds what it sends, so a pasted document cannot blow up the extraction call', async () => {
    generateObjectMock.mockResolvedValue(answer([]))
    await rememberFromTurn({ ownerId: 'u1', userText: 'u'.repeat(50_000), priorAssistantText: 'a'.repeat(50_000) })
    expect((generateObjectMock.mock.calls[0]![0].prompt as string).length).toBeLessThan(12_000)
  })

  it('never throws: a failing model or database is logged and swallowed', async () => {
    const err = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateObjectMock.mockRejectedValue(new Error('quick model down'))
    await expect(rememberFromTurn({ ownerId: 'u1', userText: 'I never trade options', priorAssistantText: '' })).resolves.toBeUndefined()
    store.listMemories.mockRejectedValue(new Error('db down'))
    await expect(rememberFromTurn({ ownerId: 'u1', userText: 'I never trade options', priorAssistantText: '' })).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('runs one extraction at a time, so two chats finishing together cannot both add the same fact', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    generateObjectMock.mockImplementationOnce(async () => {
      await gate
      return answer([{ op: 'add', ref: null, content: USD }])
    })
    generateObjectMock.mockImplementationOnce(async () => answer([{ op: 'add', ref: null, content: USD }]))

    const first = rememberFromTurn({ ownerId: 'u1', userText: 'usd is on purpose', priorAssistantText: '' })
    const second = rememberFromTurn({ ownerId: 'u1', userText: 'usd is on purpose', priorAssistantText: '' })
    release()
    await Promise.all([first, second])

    expect(store.rows).toHaveLength(1)
    expect(generateObjectMock.mock.calls[1]![0].prompt).toContain(`1. ${USD}`)
  })

  it('keeps working after a run that failed', async () => {
    const err = vi.spyOn(console, 'warn').mockImplementation(() => {})
    generateObjectMock.mockRejectedValueOnce(new Error('boom'))
    generateObjectMock.mockResolvedValueOnce(answer([{ op: 'add', ref: null, content: USD }]))
    await rememberFromTurn({ ownerId: 'u1', userText: 'a', priorAssistantText: '' })
    await rememberFromTurn({ ownerId: 'u1', userText: 'usd is on purpose', priorAssistantText: '' })
    expect(store.rows).toHaveLength(1)
    err.mockRestore()
  })
})
