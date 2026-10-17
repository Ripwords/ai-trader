export type PromptGroup = 'chat' | 'research' | 'news' | 'algo' | 'agents'
export type PromptEngine = 'web' | 'agents'

export const PROMPT_GROUP_LABELS: Record<PromptGroup, string> = {
  chat: 'Chat',
  research: 'Research',
  news: 'News',
  algo: 'Algo',
  agents: 'Agents debate',
}

/** One row of GET /api/settings/prompts. */
export interface PromptView {
  id: string
  group: PromptGroup
  label: string
  description: string
  engine: PromptEngine
  /** `{name}` fields the text may use. Always empty for web prompts. */
  placeholders: string[]
  contract: string | null
  /** Null when the agents service could not be reached for it. */
  default: string | null
  override: string | null
  modified: boolean
}

export interface PromptListResponse {
  prompts: PromptView[]
  /** Set when the agents defaults could not be fetched from the api. */
  agentsError: string | null
}

export interface PromptSaveResponse {
  modified: boolean
  warnings: string[]
}
