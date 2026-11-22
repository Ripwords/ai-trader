import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'
import { buildMemoryContext } from '../../server/llm/memory-context'
import { MEMORY_LIMIT, MEMORY_MAX_CHARS } from '../../types/memory'

const USD = 'The owner holds mostly USD assets against a MYR base; this is intentional.'
const TECH = 'The owner knows the book is tech-heavy and accepts the concentration.'

describe('buildMemoryContext', () => {
  it('is empty when nothing is saved, so the prompt carries no dangling instruction', () => {
    expect(buildMemoryContext([])).toEqual([])
    expect(buildSystemPrompt('ok')).not.toContain('OWNER MEMORY')
  })

  it('lists every memory and tells the model not to re-flag what they cover', () => {
    const block = buildMemoryContext([USD, TECH]).join('\n')
    expect(block).toContain(`- ${USD}`)
    expect(block).toContain(`- ${TECH}`)
    expect(block).toMatch(/do not re-flag/i)
  })

  it('says it outranks the default flagging rules, names the exceptions, and keeps the facts in the maths', () => {
    const block = buildMemoryContext([USD]).join('\n')
    expect(block).toMatch(/takes precedence over/i)
    expect(block).toMatch(/materially changed/i)
    expect(block).toMatch(/the owner asks/i)
    expect(block).toMatch(/sizing/i)
  })

  it('stays bounded at the caps', () => {
    const worst = Array.from({ length: MEMORY_LIMIT }, () => 'x'.repeat(MEMORY_MAX_CHARS))
    const block = buildMemoryContext(worst).join('\n')
    expect(block.length).toBeLessThan(MEMORY_LIMIT * (MEMORY_MAX_CHARS + 3) + 2_000)
  })
})

describe('buildSystemPrompt with memories', () => {
  it('puts the memory block in the runtime context, after the editable text and its flagging rules', () => {
    const p = buildSystemPrompt('ok', 'run 42 for NVDA', { memories: [USD] })
    const runtimeAt = p.indexOf('RUNTIME CONTEXT')
    const memoryAt = p.indexOf('OWNER MEMORY')
    expect(memoryAt).toBeGreaterThan(runtimeAt)
    expect(memoryAt).toBeGreaterThan(p.indexOf('ringgit appreciation is a drag'))
    expect(p).toContain(`- ${USD}`)
    expect(p).toContain('run 42 for NVDA')
  })
})
