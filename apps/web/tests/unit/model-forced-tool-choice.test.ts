import { describe, it, expect } from 'vitest'
import { supportsForcedToolChoice } from '../../server/llm/model'

/**
 * DeepSeek's thinking-mode models reject a forced `tool_choice` outright:
 *   400 invalid_request_error "Thinking mode does not support this tool_choice"
 * which kills the whole stream, so every slash command (/investment-research,
 * /news-pulse, /ta, ...) fails while plain chat keeps working. They do still
 * call the right tool under `tool_choice: "auto"` when the dispatch directive
 * names it, so the fallback keeps the dispatch and loses only its determinism.
 *
 * Verified against the live API on 2026-09-05: `GET /models` lists only
 * v4-pro, v4-flash and v4-flash-vision-exp, and every one of them rejects a
 * forced tool_choice. The deprecated deepseek-chat alias was the last
 * non-thinking model, so the whole provider is now a no.
 */
describe('supportsForcedToolChoice', () => {
  it('allows forcing on non-reasoning providers', () => {
    expect(supportsForcedToolChoice('anthropic/claude-sonnet-4-6')).toBe(true)
    expect(supportsForcedToolChoice('openai/gpt-4o')).toBe(true)
    expect(supportsForcedToolChoice('google/gemini-2.5-pro')).toBe(true)
  })

  it('refuses forcing on every current DeepSeek model', () => {
    expect(supportsForcedToolChoice('deepseek/deepseek-v4-pro')).toBe(false)
    expect(supportsForcedToolChoice('deepseek/deepseek-v4-flash')).toBe(false)
    expect(supportsForcedToolChoice('deepseek/deepseek-v4-flash-vision-exp')).toBe(false)
  })

  it('refuses forcing on the deprecated deepseek aliases too', () => {
    // Still resolve server-side for now, but they are out of the catalog and
    // route to a thinking model, so forcing must not come back for them.
    expect(supportsForcedToolChoice('deepseek/deepseek-chat')).toBe(false)
    expect(supportsForcedToolChoice('deepseek/deepseek-reasoner')).toBe(false)
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
