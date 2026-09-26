import { describe, expect, it } from 'vitest'
import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import { incompleteReplyNote, watchReplyEnding } from '../../server/llm/chat-ending'

const usage: LanguageModelUsage = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
}
const delta = (text: string): TextStreamPart<ToolSet> => ({ type: 'text-delta', id: 't', text })
const finish = (finishReason: FinishReason): TextStreamPart<ToolSet> => ({
  type: 'finish', finishReason, rawFinishReason: finishReason, totalUsage: usage,
})
const step = (finishReason: FinishReason): TextStreamPart<ToolSet> => ({
  type: 'finish-step',
  finishReason,
  rawFinishReason: finishReason,
  usage,
  providerMetadata: undefined,
  response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
})

describe('incompleteReplyNote', () => {
  const base = { answered: true, steps: 1, maxSteps: 30 }

  it('says nothing about a reply that answered and stopped normally', () => {
    expect(incompleteReplyNote({ ...base, finishReason: 'stop' })).toBeNull()
  })

  it('names an empty completion', () => {
    expect(incompleteReplyNote({ ...base, answered: false, finishReason: 'stop' })).toBe('The model returned no answer.')
    expect(incompleteReplyNote({ ...base, answered: false, finishReason: 'other' })).toBe('The model returned no answer.')
  })

  it('names a reply cut off by the output limit or a content filter, even with text', () => {
    expect(incompleteReplyNote({ ...base, finishReason: 'length' })).toMatch(/output limit/)
    expect(incompleteReplyNote({ ...base, finishReason: 'content-filter' })).toMatch(/content filter/)
  })

  it('names the step limit when the last step was a tool call', () => {
    expect(incompleteReplyNote({ ...base, steps: 30, finishReason: 'tool-calls' })).toMatch(/step limit \(30 steps\)/)
    expect(incompleteReplyNote({ ...base, steps: 3, finishReason: 'tool-calls' })).toMatch(/after a tool call/)
  })

  it('leaves provider errors to the error handler', () => {
    expect(incompleteReplyNote({ ...base, answered: false, finishReason: 'error' })).toBeNull()
  })
})

describe('watchReplyEnding', () => {
  it('stamps the note on the finish part only', () => {
    const watch = watchReplyEnding(2)
    expect(watch(step('tool-calls'))).toBeUndefined()
    expect(watch(step('tool-calls'))).toBeUndefined()
    expect(watch(finish('tool-calls'))).toEqual({ error: expect.stringMatching(/step limit \(2 steps\)/) })
  })

  it('counts whitespace-only text as no answer', () => {
    const watch = watchReplyEnding(30)
    watch(delta('  \n'))
    watch(step('stop'))
    expect(watch(finish('stop'))).toEqual({ error: 'The model returned no answer.' })
  })

  it('returns nothing for a normal answer', () => {
    const watch = watchReplyEnding(30)
    watch(delta('Hello'))
    watch(step('stop'))
    expect(watch(finish('stop'))).toBeUndefined()
  })
})
