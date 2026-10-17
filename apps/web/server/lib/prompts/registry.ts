import type { PromptGroup } from '../../../types/prompts'
import {
  ALGO_CODEGEN_DEFAULT,
  CHAT_SYSTEM_DEFAULT,
  CONTEXTUAL_ANGLES_DEFAULT,
  MOOMOO_RULES_DEFAULT,
  RISK_REPORT_DEFAULT,
} from './defaults'

interface PromptBase {
  id: string
  group: PromptGroup
  label: string
  description: string
  /** A literal the output must keep, because code parses it. Missing it warns on save. */
  contract?: string
}

/** Used by the web app. Plain text: no placeholders, braces are literal. */
export interface WebPromptMeta extends PromptBase {
  engine: 'web'
  default: string
}

/**
 * Used by the TradingAgents debate in the api. The default and its
 * `{placeholders}` live in the Python package and are fetched from the api.
 */
export interface AgentsPromptMeta extends PromptBase {
  engine: 'agents'
  /** The api's name for the prompt: the `.md` file name, or `confidence_judge`. */
  agentName: string
}

export type PromptMeta = WebPromptMeta | AgentsPromptMeta

const WEB_PROMPTS = [
  {
    id: 'chat.system',
    group: 'chat',
    label: 'Chat system prompt',
    description: 'The copilot\'s standing instructions: which tool to call for what, currency rules, trade safety, alerts and reminders. The server appends the current time, Ghostfolio status, recent research runs and slash-command directives after it.',
    engine: 'web',
    default: CHAT_SYSTEM_DEFAULT,
  },
  {
    id: 'chat.moomoo_rules',
    group: 'chat',
    label: 'moomoo rules',
    description: 'Stock-code formats, the name-to-code lookup table, and broker rules. Appended to the chat system prompt.',
    engine: 'web',
    default: MOOMOO_RULES_DEFAULT,
  },
  {
    id: 'research.risk_report',
    group: 'research',
    label: 'Risk report',
    description: 'Scores the valuation, health and growth pillars for the research page\'s risk report. The output shape is fixed by a schema.',
    engine: 'web',
    default: RISK_REPORT_DEFAULT,
  },
  {
    id: 'news.contextual_angles',
    group: 'news',
    label: 'News search angles',
    description: 'Writes the macro, sector and peer search queries that explain why a stock moved. Runs on the quick model.',
    engine: 'web',
    default: CONTEXTUAL_ANGLES_DEFAULT,
  },
  {
    id: 'algo.codegen',
    group: 'algo',
    label: 'Strategy assistant',
    description: 'The assistant on /algo that writes and edits sandboxed strategy code. The current strategy code is appended after it.',
    engine: 'web',
    default: ALGO_CODEGEN_DEFAULT,
  },
] as const satisfies readonly WebPromptMeta[]

const agents = (agentName: string, label: string, description: string, contract?: string): AgentsPromptMeta => ({
  id: `agents.${agentName}`,
  group: 'agents',
  label,
  description,
  engine: 'agents',
  agentName,
  ...(contract ? { contract } : {}),
})

const AGENTS_PROMPTS: readonly AgentsPromptMeta[] = [
  agents('market_analyst', 'Market analyst', 'Reads price data and indicators and writes the market report.'),
  agents('social_media_analyst', 'Social media analyst', 'Writes the sentiment report from social and news chatter.'),
  agents('news_analyst', 'News analyst', 'Writes the news and macro report.'),
  agents('fundamentals_analyst', 'Fundamentals analyst', 'Reads the financial statements and writes the fundamentals report.'),
  agents('bull_researcher', 'Bull researcher', 'Argues the case for the stock in the investment debate.'),
  agents('bear_researcher', 'Bear researcher', 'Argues the case against the stock in the investment debate.'),
  agents('research_manager', 'Research manager', 'Judges the bull/bear debate and writes the investment plan.'),
  agents('trader_system', 'Trader (system)', 'The trader\'s standing instructions for turning the plan into a trade.'),
  agents('trader_user', 'Trader (request)', 'The message that hands the trader the investment plan.'),
  agents('aggressive_debator', 'Aggressive risk analyst', 'Argues for taking more risk in the risk debate.'),
  agents('conservative_debator', 'Conservative risk analyst', 'Argues for taking less risk in the risk debate.'),
  agents('neutral_debator', 'Neutral risk analyst', 'Weighs both sides in the risk debate.'),
  agents(
    'risk_manager',
    'Risk manager',
    'Makes the final call. Its reply must keep the FINAL TRANSACTION PROPOSAL line, which the rating is read from.',
    'FINAL TRANSACTION PROPOSAL',
  ),
  agents(
    'confidence_judge',
    'Confidence judge',
    'Audits the final call and states the probability it is right. Its reply must keep a CONFIDENCE: line, which the confidence score is read from.',
    'CONFIDENCE:',
  ),
]

export const PROMPT_REGISTRY: readonly PromptMeta[] = [...WEB_PROMPTS, ...AGENTS_PROMPTS]

export type WebPromptId = (typeof WEB_PROMPTS)[number]['id']

export function findPrompt(id: string): PromptMeta | undefined {
  return PROMPT_REGISTRY.find(p => p.id === id)
}

export function webDefault(id: WebPromptId): string {
  return WEB_PROMPTS.find(p => p.id === id)!.default
}
