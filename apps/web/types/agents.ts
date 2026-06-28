export type Rating = 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'
export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled'

/** Tags for the four analyst reports. Match graph._REPORT_KIND_MAP. */
export type ReportKind = 'market' | 'sentiment' | 'news' | 'fundamentals'

/** Risk debate seats — three voices instead of bull/bear. */
export type RiskSpeaker = 'aggressive' | 'conservative' | 'neutral'

/** Synthesis stage tags. ``judge-decision`` is the Research Manager's
 *  closing argument on the bull/bear debate; ``investment-plan`` is the
 *  same RM's synthesised plan; ``trader-plan`` is the Trader's expanded
 *  execution plan. All three sit between debate and verdict in the
 *  pipeline. */
export type SynthesisStage = 'judge-decision' | 'investment-plan' | 'trader-plan'

export type AgentEvent =
  | { type: 'run-start'; run_id: string; symbol: string; config: Record<string, unknown> }
  | { type: 'node-start'; node: string }
  | { type: 'tool-call'; node: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool-result'; node: string; tool: string; ok: boolean; preview: string }
  | { type: 'node-message'; node: string; delta: string }
  | { type: 'node-end'; node: string; summary: string }
  | { type: 'debate-round'; round: number; side: 'bull' | 'bear'; text: string }
  | { type: 'risk-debate-turn'; speaker: RiskSpeaker; text: string; turn: number }
  | { type: 'report'; kind: ReportKind; node: string; content: string }
  | { type: 'synthesis'; stage: SynthesisStage; node: string; content: string }
  | { type: 'decision'; rating: Rating; confidence: number | null; rationale: string }
  | { type: 'valuation-veto'; original_rating: string; effective_rating: string; reason: string; rating_cap: string }
  | { type: 'final-state'; state: Record<string, unknown> }
  | { type: 'run-end'; run_id: string; tokens_in: number; tokens_out: number; cost_usd: number }
  | { type: 'error'; node?: string; message: string }
