import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateTextMock = vi.fn()
vi.mock('ai', () => ({ generateText: generateTextMock }))
const resolveModelMock = vi.fn(async () => ({ model: {}, spec: 'deepseek/deepseek-chat', providerKind: 'deepseek', modelId: 'deepseek-chat' }))
vi.mock('../../server/llm/model', () => ({ resolveModel: resolveModelMock }))
const recordUsageSafely = vi.fn()
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely }))
vi.mock('../../server/lib/prompts/store', () => ({ readPromptOverrides: async () => ({}) }))
const retitleThread = vi.fn(async (_id: string, _from: string, _to: string) => true)
vi.mock('../../server/db/repo', () => ({ retitleThread }))

const { cleanTitle, nameThread } = await import('../../server/lib/chat-title')

beforeEach(() => {
  generateTextMock.mockReset()
  retitleThread.mockClear()
  recordUsageSafely.mockClear()
})

describe('cleanTitle', () => {
  it('strips quotes, markdown and a trailing full stop', () => {
    expect(cleanTitle('"**NVDA Q3 earnings reaction.**"\n')).toBe('NVDA Q3 earnings reaction')
  })

  it('gives up on an empty or overlong answer rather than saving junk', () => {
    expect(cleanTitle('  ')).toBeNull()
    expect(cleanTitle('x '.repeat(80))).toBeNull()
  })
})

describe('nameThread', () => {
  it('replaces the truncated question with a short title from the quick model, and records the cost', async () => {
    generateTextMock.mockResolvedValue({ text: 'AMZN Q3 cloud margin check', usage: { inputTokens: 80, outputTokens: 7 } })
    await nameThread('th-1', 'is amazon still a buy after q3, look at aws margins and capex please', 'is amazon still a buy after q3, look at aws margins and ca…')
    expect(resolveModelMock).toHaveBeenCalledWith('quick')
    expect(retitleThread).toHaveBeenCalledWith('th-1', 'is amazon still a buy after q3, look at aws margins and ca…', 'AMZN Q3 cloud margin check')
    expect(recordUsageSafely).toHaveBeenCalledWith(expect.objectContaining({ source: 'chat-title', inputTokens: 80, outputTokens: 7 }))
  })

  it('leaves room for a reasoning model to think before it answers, and keeps the question when the answer is empty', async () => {
    generateTextMock.mockResolvedValue({ text: '', usage: { inputTokens: 80, outputTokens: 600 } })
    await nameThread('th-1', 'q', 'q')
    expect(generateTextMock.mock.calls[0]?.[0].maxOutputTokens).toBeGreaterThanOrEqual(400)
    expect(retitleThread).not.toHaveBeenCalled()
  })

  it('keeps the question as the title when the quick model fails, and never throws into the reply', async () => {
    generateTextMock.mockRejectedValue(new Error('no quick model'))
    await expect(nameThread('th-1', 'q', 'q')).resolves.toBeUndefined()
    expect(retitleThread).not.toHaveBeenCalled()
  })
})
