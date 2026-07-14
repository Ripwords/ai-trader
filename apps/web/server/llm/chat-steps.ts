// Resolves how many agentic steps (model generations) the chat loop may run
// before stopping. A "step" is one model turn; each round of tool calls costs
// a step, so a low cap makes multi-tool / long-context conversations end
// prematurely without a final answer. Default 30, user-overridable per request,
// with an env fallback for operators.

export const DEFAULT_CHAT_MAX_STEPS = 30
export const MIN_CHAT_STEPS = 1
export const MAX_CHAT_STEPS = 100

function clamp(n: number): number {
  return Math.min(MAX_CHAT_STEPS, Math.max(MIN_CHAT_STEPS, Math.round(n)))
}

/**
 * Precedence: explicit per-request value (from the client) → CHAT_MAX_STEPS env
 * → DEFAULT_CHAT_MAX_STEPS. Invalid values are ignored rather than throwing so
 * the chat never hard-fails on a bad setting; valid values are clamped to
 * [MIN_CHAT_STEPS, MAX_CHAT_STEPS].
 */
export function resolveMaxSteps(requested: number | undefined | null): number {
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return clamp(requested)
  }
  const envRaw = process.env.CHAT_MAX_STEPS
  if (envRaw != null && envRaw !== '') {
    const envNum = Number(envRaw)
    if (Number.isFinite(envNum)) return clamp(envNum)
  }
  return DEFAULT_CHAT_MAX_STEPS
}
