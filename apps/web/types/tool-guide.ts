/**
 * The /tools guide as it travels from the chat route to the chat card. The
 * route writes it as a UI message data part (never a tool call, so the model
 * never sees it in later turns); the card renders it.
 */
export const TOOL_GUIDE_PART_TYPE = 'data-tool-guide'

export interface ToolGuideTool {
  name: string
  what: string
  useWhen: string
  example: string
  /** Slash commands (without the leading slash) that run this tool directly. */
  slash: string[]
}

export interface ToolGuideCategory {
  category: string
  blurb: string
  tools: ToolGuideTool[]
}

export interface ToolGuideCommand {
  name: string
  /** e.g. `/management-deep-dive <person> <symbol>` */
  usage: string
  description: string
}

export interface ToolGuide {
  categories: ToolGuideCategory[]
  commands: ToolGuideCommand[]
  notes: string[]
}
