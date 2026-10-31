import type { InferUITools } from 'ai'
import type { makeTools } from '../../server/llm/tools'
import { TOOL_GUIDE_PART_TYPE, type ToolGuide } from '../../types/tool-guide'

export type ChatTools = InferUITools<ReturnType<typeof makeTools>>
export type ChatToolName = keyof ChatTools
export type ChatToolOutput<N extends ChatToolName> = ChatTools[N]['output']

function partToolName(part: Record<string, unknown>): string | undefined {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : undefined
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice('tool-'.length)
  return undefined
}

/**
 * The finished output of a chat tool part, typed from the server's tool
 * definitions, or undefined when the part is another tool or not done yet.
 */
export function toolOutputOf<N extends ChatToolName>(part: unknown, name: N): ChatToolOutput<N> | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  const p = part as Record<string, unknown>
  if (partToolName(p) !== name || p.state !== 'output-available') return undefined
  return p.output as ChatToolOutput<N>
}

function isToolGuide(data: unknown): data is ToolGuide {
  if (typeof data !== 'object' || data === null) return false
  return 'categories' in data && Array.isArray(data.categories)
    && 'commands' in data && Array.isArray(data.commands)
    && 'notes' in data && Array.isArray(data.notes)
}

/** The /tools guide carried by a message part, or undefined for any other part. */
export function toolGuideOf(part: unknown): ToolGuide | undefined {
  if (typeof part !== 'object' || part === null) return undefined
  if (!('type' in part) || part.type !== TOOL_GUIDE_PART_TYPE || !('data' in part)) return undefined
  return isToolGuide(part.data) ? part.data : undefined
}
