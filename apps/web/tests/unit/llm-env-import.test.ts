import { describe, expect, it } from 'vitest'
import { planEnvImport } from '../../server/lib/llm-env-import'

describe('planEnvImport', () => {
  it('imports real keys, skips .env.example placeholders, and selects LLM_MODEL with its quick default', () => {
    const plan = planEnvImport({
      LLM_MODEL: 'deepseek/deepseek-v4-pro',
      DEEPSEEK_API_KEY: 'sk-real-deepseek',
      ANTHROPIC_API_KEY: 'sk-ant-...',
      OPENAI_API_KEY: '',
    })
    expect(plan).toEqual({
      providers: [{ kind: 'deepseek', apiKey: 'sk-real-deepseek' }],
      selection: {
        chat: { kind: 'deepseek', modelId: 'deepseek-v4-pro' },
        quick: { kind: 'deepseek', modelId: 'deepseek-v4-flash' },
      },
    })
  })

  it('honours LLM_MODEL_QUICK when its provider has a key', () => {
    const plan = planEnvImport({
      LLM_MODEL: 'anthropic/claude-opus-4-7',
      LLM_MODEL_QUICK: 'openai/gpt-4o-mini',
      ANTHROPIC_API_KEY: 'sk-ant-real',
      OPENAI_API_KEY: 'sk-openai-real',
    })
    expect(plan?.selection).toEqual({
      chat: { kind: 'anthropic', modelId: 'claude-opus-4-7' },
      quick: { kind: 'openai', modelId: 'gpt-4o-mini' },
    })
  })

  it('defaults LLM_MODEL the way the env-based factory did', () => {
    const plan = planEnvImport({ ANTHROPIC_API_KEY: 'sk-ant-real' })
    expect(plan?.selection?.chat).toEqual({ kind: 'anthropic', modelId: 'claude-sonnet-4-6' })
  })

  it('imports the keys but selects nothing when LLM_MODEL names a provider without a key', () => {
    const plan = planEnvImport({ LLM_MODEL: 'google/gemini-2.5-pro', OPENAI_API_KEY: 'sk-openai-real' })
    expect(plan).toEqual({ providers: [{ kind: 'openai', apiKey: 'sk-openai-real' }], selection: null })
  })

  it('has nothing to import without any key', () => {
    expect(planEnvImport({ LLM_MODEL: 'anthropic/claude-sonnet-4-6' })).toBeNull()
  })
})
