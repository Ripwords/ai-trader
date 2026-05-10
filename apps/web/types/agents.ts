export type Rating = 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'
export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled'

export type AgentEvent =
  | { type: 'run-start'; run_id: string; symbol: string; config: Record<string, unknown> }
  | { type: 'node-start'; node: string }
  | { type: 'tool-call'; node: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool-result'; node: string; tool: string; ok: boolean; preview: string }
  | { type: 'node-message'; node: string; delta: string }
  | { type: 'node-end'; node: string; summary: string }
  | { type: 'debate-round'; round: number; side: 'bull' | 'bear'; text: string }
  | { type: 'decision'; rating: Rating; confidence: number; rationale: string }
  | { type: 'run-end'; run_id: string; tokens_in: number; tokens_out: number; cost_usd: number }
  | { type: 'error'; node?: string; message: string }
