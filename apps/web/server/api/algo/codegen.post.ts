/**
 * Streaming endpoint for the strategy-authoring assistant on /algo/[id].
 *
 * Differs from /api/chat: no thread persistence (these conversations are
 * scratch), one tool only (`propose_config` for proposing backtest-config
 * tweaks — code edits flow as fenced python blocks), tightly-scoped system
 * prompt that documents the sandbox DSL so the model doesn't suggest
 * disallowed imports.
 */
import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../../llm/model'
import { DEFAULT_CHAT_MAX_STEPS } from '../../llm/chat-steps'
import { recordUsageSafely } from '../../lib/llm-cost'
import { getPrompt } from '../../lib/prompts'

interface CodegenBody {
  messages: UIMessage[]
  currentCode?: string
  symbol?: string
  cadence?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<CodegenBody>(event)
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'messages required' })
  }

  // Inject the user's current code as system context so the model can refine
  // rather than start from scratch every turn.
  const ctx = body.currentCode
    ? `\n\nCURRENT STRATEGY (symbol=${body.symbol ?? 'unknown'}, cadence=${body.cadence ?? 'unknown'}):\n\`\`\`python\n${body.currentCode}\n\`\`\``
    : ''

  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  // Tool: propose backtest-config changes. Echoes the input back as the
  // result so the frontend can render an Apply / Discard card. The actual
  // mutation lives in the page (it merges into draft and goes through the
  // normal Save flow), so the assistant can't overwrite the user's work.
  const proposeConfig = tool({
    description: [
      'Propose changes to the strategy\'s backtest configuration.',
      'Pass only the fields you want to change. The user reviews the',
      'proposed values and clicks Apply to commit them into the draft.',
    ].join(' '),
    inputSchema: z.object({
      initial_capital: z.number().gt(0).optional()
        .describe('Starting cash in dollars for backtests'),
      commission_bps: z.number().int().min(0).max(1000).optional()
        .describe('Per-trade commission in basis points (10 = 0.10%)'),
      slippage_bps: z.number().int().min(0).max(1000).optional()
        .describe('Slippage applied to fills in basis points (5 = 0.05%)'),
      sizing_mode: z.enum(['fixed_qty', 'pct_equity', 'fixed_cash']).optional()
        .describe('How signals translate into share counts'),
      sizing_value: z.number().gt(0).optional()
        .describe('Shares for fixed_qty, % (0..100) for pct_equity, $ for fixed_cash'),
      pyramiding_max: z.number().int().min(1).max(100).optional()
        .describe('Max consecutive BUYs without an intervening flatten'),
    }),
    execute: async (input) => ({ proposed: input }),
  })

  const resolved = await resolveModel('chat')
  const result = streamText({
    model: resolved.model,
    system: (await getPrompt('algo.codegen')) + ctx,
    messages: modelMessages,
    tools: { propose_config: proposeConfig },
    stopWhen: stepCountIs(DEFAULT_CHAT_MAX_STEPS),
    onFinish: ({ totalUsage }) => recordUsageSafely({
      source: 'algo-codegen',
      modelSpec: resolved.spec,
      inputTokens: totalUsage.inputTokens ?? 0,
      outputTokens: totalUsage.outputTokens ?? 0,
    }),
  })

  return result.toUIMessageStreamResponse()
})
