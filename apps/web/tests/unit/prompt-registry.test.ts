import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ overrides: {} as Record<string, string>, fail: false }))
vi.mock('../../server/lib/prompts/store', () => ({
  readPromptOverrides: async () => {
    if (store.fail) throw new Error('db down')
    return store.overrides
  },
}))

const { PROMPT_REGISTRY, findPrompt, webDefault } = await import('../../server/lib/prompts/registry')
const { getPrompt } = await import('../../server/lib/prompts')

beforeEach(() => {
  store.overrides = {}
  store.fail = false
})

describe('prompt registry', () => {
  it('lists every editable prompt once', () => {
    const ids = PROMPT_REGISTRY.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([
      'chat.system',
      'chat.moomoo_rules',
      'research.risk_report',
      'news.contextual_angles',
      'algo.codegen',
      'agents.market_analyst',
      'agents.social_media_analyst',
      'agents.news_analyst',
      'agents.fundamentals_analyst',
      'agents.bull_researcher',
      'agents.bear_researcher',
      'agents.research_manager',
      'agents.trader_system',
      'agents.trader_user',
      'agents.aggressive_debator',
      'agents.conservative_debator',
      'agents.neutral_debator',
      'agents.risk_manager',
      'agents.confidence_judge',
    ])
  })

  it('pins the output contracts the parsers depend on', () => {
    expect(findPrompt('agents.risk_manager')?.contract).toBe('FINAL TRANSACTION PROPOSAL')
    expect(findPrompt('agents.confidence_judge')?.contract).toBe('CONFIDENCE:')
  })

  it('keeps the runtime parts out of the editable chat body', () => {
    const body = webDefault('chat.system')
    expect(body.startsWith('You are a trading copilot.')).toBe(true)
    expect(body).not.toContain('Ghostfolio tracker tools are NOT enabled')
    expect(body).not.toContain('Ghostfolio is configured but the MCP connection')
    expect(body).not.toContain('## moomoo OpenAPI rules')
  })
})

describe('getPrompt', () => {
  it('returns the default when nothing is stored', async () => {
    expect(await getPrompt('news.contextual_angles')).toBe(webDefault('news.contextual_angles'))
  })

  it('returns the stored override', async () => {
    store.overrides = { 'news.contextual_angles': 'custom angles' }
    expect(await getPrompt('news.contextual_angles')).toBe('custom angles')
  })

  it('falls back to the default when the store cannot be read', async () => {
    store.fail = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getPrompt('algo.codegen')).toBe(webDefault('algo.codegen'))
    err.mockRestore()
  })
})
