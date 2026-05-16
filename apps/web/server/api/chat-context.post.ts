import { convertToModelMessages } from 'ai'
import { buildSystemPrompt, estimateChatInputTokens } from '../llm/chat-context'
import { getApiClient } from '../llm/http'
import { getGhostfolioStatus, getGhostfolioTools } from '../llm/mcp'
import { getModelInfo } from '../llm/model'
import { makeTools } from '../llm/tools'

interface ChatContextBody {
  messages?: Array<{ id?: string; role: string; parts?: unknown[]; [k: string]: unknown }>
}

export default defineEventHandler(async (event) => {
  const body = await readBody<ChatContextBody>(event)
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const model = getModelInfo()
  const [ghostfolioStatus, ghostfolioTools] = await Promise.all([
    getGhostfolioStatus(),
    getGhostfolioTools(),
  ])
  const modelMessages = messages.length
    ? await convertToModelMessages(messages as Parameters<typeof convertToModelMessages>[0])
    : []
  const toolNames = Object.keys({ ...makeTools(getApiClient(), event), ...ghostfolioTools })
  const estimate = estimateChatInputTokens({
    system: buildSystemPrompt(ghostfolioStatus),
    modelMessages,
    toolNames,
  })
  const estimatedTotalTokens = estimate.totalInputTokens + model.outputReserve
  const remainingTokens = Math.max(0, model.contextWindow - estimatedTotalTokens)
  const usagePct = model.contextWindow > 0 ? estimatedTotalTokens / model.contextWindow : 0
  const status = usagePct >= 0.9 ? 'critical' : usagePct >= 0.7 ? 'warn' : 'ok'

  return {
    modelSpec: model.spec,
    provider: model.provider,
    modelId: model.modelId,
    contextWindow: model.contextWindow,
    contextWindowSource: model.contextWindowSource,
    estimatedInputTokens: estimate.totalInputTokens,
    outputReserveTokens: model.outputReserve,
    estimatedTotalTokens,
    remainingTokens,
    usagePct,
    status,
    approximate: true,
    breakdown: {
      systemTokens: estimate.systemTokens,
      messageTokens: estimate.messageTokens,
      toolSchemaTokens: estimate.toolSchemaTokens,
    },
  }
})
