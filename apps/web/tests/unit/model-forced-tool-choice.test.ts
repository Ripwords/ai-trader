import { describe, it, expect } from 'vitest'
import { supportsForcedToolChoice } from '../../server/llm/model'

/**
 * DeepSeek's thinking-mode models reject a forced `tool_choice` outright:
 *   400 invalid_request_error "Thinking mode does not support this tool_choice"
 * which kills the whole stream, so every slash command (/investment-research,
 * /news-pulse, /ta, ...) fails while plain chat keeps working. Verified against
 * the live API on 2026-09-05: v4-pro, v4-flash and reasoner all reject it;
 * deepseek-chat accepts it. They do still call the right tool under
 * `tool_choice: "auto"` when the dispatch directive names it.
 */
describe('supportsForcedToolChoice', () => {
  it('allows forcing on non-reasoning providers', () => {
    expect(supportsForcedToolChoice('anthropic/claude-sonnet-4-6')).toBe(true)
    expect(supportsForcedToolChoice('openai/gpt-4o')).toBe(true)
    expect(supportsForcedToolChoice('google/gemini-2.5-pro')).toBe(true)
  })

  it('refuses forcing on DeepSeek thinking-mode models', () => {
    expect(supportsForcedToolChoice('deepseek/deepseek-v4-pro')).toBe(false)
    expect(supportsForcedToolChoice('deepseek/deepseek-v4-flash')).toBe(false)
    expect(supportsForcedToolChoice('deepseek/deepseek-reasoner')).toBe(false)
  })

  it('allows forcing on the non-thinking deepseek-chat model', () => {
    expect(supportsForcedToolChoice('deepseek/deepseek-chat')).toBe(true)
  })

  it('treats unknown deepseek model ids as thinking-mode (fail safe)', () => {
    expect(supportsForcedToolChoice('deepseek/deepseek-v5-whatever')).toBe(false)
  })

  it('is overridable by env for a model the allowlist does not know yet', () => {
    process.env.LLM_FORCE_TOOL_CHOICE = 'true'
    try {
      expect(supportsForcedToolChoice('deepseek/deepseek-v4-pro')).toBe(true)
    } finally {
      delete process.env.LLM_FORCE_TOOL_CHOICE
    }
  })

  it('reads LLM_MODEL when no spec is passed', () => {
    const prev = process.env.LLM_MODEL
    process.env.LLM_MODEL = 'deepseek/deepseek-v4-pro'
    try {
      expect(supportsForcedToolChoice()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.LLM_MODEL
      else process.env.LLM_MODEL = prev
    }
  })
})
