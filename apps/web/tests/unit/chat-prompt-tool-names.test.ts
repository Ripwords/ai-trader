import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'
import { SLASH_COMMANDS } from '../../server/llm/research/commands'
import { makeTools } from '../../server/llm/tools'
import type { ApiClient } from '../../server/llm/http'

/**
 * Every tool the system prompt or a slash command tells the model to call must
 * exist in the catalogue. A renamed or merged tool that the prompt still names
 * sends the model chasing a tool it cannot call; this gate turns that into a
 * failing test instead of a confused chat turn.
 */

const TOOL_PREFIXES = [
  'market', 'watchlist', 'search', 'news', 'trade', 'portfolio', 'value', 'technical', 'algo',
  'research', 'investment', 'thesis', 'dyp', 'agents', 'holdings', 'convert', 'usage', 'alert',
]

/** Snake-case identifiers in the prompt that share a tool prefix but are data fields. */
const NOT_TOOLS = new Set(['market_val', 'trade_env'])

function catalogue(): Set<string> {
  return new Set(Object.keys(makeTools({} as ApiClient)))
}

function toolLikeTokens(text: string): string[] {
  const re = new RegExp(`\\b(?:${TOOL_PREFIXES.join('|')})_[a-z_]+\\b`, 'g')
  return [...new Set(text.match(re) ?? [])].filter(t => !NOT_TOOLS.has(t))
}

describe('system prompt tool references', () => {
  it('names only tools that exist in the catalogue', () => {
    const known = catalogue()
    for (const status of ['ok', 'failing', 'not_configured'] as const) {
      const missing = toolLikeTokens(buildSystemPrompt(status)).filter(t => !known.has(t))
      expect(missing, `prompt (${status}) names unknown tools`).toEqual([])
    }
  })

  it('never mentions ghostfolio tools outside the read-only allowlist', async () => {
    const { GHOSTFOLIO_TOOL_ALLOWLIST } = await import('../../server/llm/mcp')
    const mentioned = buildSystemPrompt('ok').match(/\bghostfolio_[a-z_]+\b/g) ?? []
    for (const name of mentioned) {
      expect(GHOSTFOLIO_TOOL_ALLOWLIST.has(name.replace(/^ghostfolio_/, ''))).toBe(true)
    }
  })
})

describe('slash command targets', () => {
  it('dispatch to tools that exist in the catalogue', () => {
    const known = catalogue()
    for (const cmd of SLASH_COMMANDS) {
      expect(known.has(cmd.tool), `/${cmd.name} -> ${cmd.tool}`).toBe(true)
    }
  })
})
