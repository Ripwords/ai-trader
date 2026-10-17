import type { GhostfolioStatus } from './mcp'
import { webDefault } from '../lib/prompts/registry'

export interface SystemPromptParts {
  /** Editable chat body (Settings → Prompts `chat.system`). Defaults to the registry text. */
  body?: string
  /** Editable moomoo rules (`chat.moomoo_rules`). */
  moomooRules?: string
  /** The `Current date/time: …` line in the user's timezone. */
  currentDateTime?: string
}

/**
 * The chat system prompt: the editable text first, then a delimited block of
 * what the server knows only at request time. Pure, so tests pass the parts in.
 */
export function buildSystemPrompt(
  ghostfolioStatus: GhostfolioStatus,
  recallContext?: string,
  parts: SystemPromptParts = {},
): string {
  const ghostfolioIntro =
    ghostfolioStatus === 'ok'
      ? 'Ghostfolio is a portfolio tracker / reconciliation source (exposed via ghostfolio_* MCP tools). It is NOT a broker account and must not be added to moomoo as if it were independent.'
      : ghostfolioStatus === 'failing'
        ? 'Ghostfolio is configured but the MCP connection is currently FAILING. If the user asks about tracked portfolio holdings, tell them Ghostfolio is misbehaving and fall back to moomoo trade_* tools for broker-side data.'
        : 'Ghostfolio tracker tools are NOT enabled in this session. Do not promise or reference ghostfolio_* tools. If the user asks about tracked portfolio holdings, say Ghostfolio integration is not currently configured (the user can enable it by setting GHOSTFOLIO_MCP_URL and GHOSTFOLIO_MCP_BEARER in .env for their remote Ghostfolio MCP endpoint).'

  const holdingsGuidance =
    ghostfolioStatus === 'ok'
      ? 'For owned shares in the moomoo account, use moomoo trade_* data. For tracked portfolio totals, use Ghostfolio. When both sources are present, reconcile them: Ghostfolio should match broker records for the same account. NEVER add Ghostfolio quantity/value and moomoo quantity/value together for the same symbol.'
      : ghostfolioStatus === 'failing'
        ? 'For portfolio / holdings, fall back to the moomoo trade_* tools and tell the user Ghostfolio (their tracker / reconciliation source) is unavailable right now.'
        : 'For portfolio / holdings, use the moomoo trade_* tools - that is the only broker data we have access to right now.'

  return [
    parts.body ?? webDefault('chat.system'),
    '',
    parts.moomooRules ?? webDefault('chat.moomoo_rules'),
    '',
    '=== RUNTIME CONTEXT (added by the server for this turn) ===',
    ...(parts.currentDateTime ? [parts.currentDateTime] : []),
    ghostfolioIntro,
    holdingsGuidance,
    ...(recallContext
      ? ['', 'RECENT RESEARCH RUNS (for tickers in the latest message):', recallContext]
      : []),
  ].join('\n')
}

export function estimateTokenCount(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export function estimateChatInputTokens(args: {
  system: string
  modelMessages: unknown[]
  toolNames: string[]
}): {
  systemTokens: number
  messageTokens: number
  toolSchemaTokens: number
  totalInputTokens: number
} {
  const systemTokens = estimateTokenCount(args.system)
  const messageTokens = estimateTokenCount(args.modelMessages) + args.modelMessages.length * 4
  const toolSchemaTokens = 1_500 + args.toolNames.length * 160
  return {
    systemTokens,
    messageTokens,
    toolSchemaTokens,
    totalInputTokens: systemTokens + messageTokens + toolSchemaTokens,
  }
}
