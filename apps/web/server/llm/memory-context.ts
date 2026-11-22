/**
 * The owner's saved memories as lines for the chat prompt's runtime block,
 * with the rule for using them. Empty when nothing is saved. The rule is
 * worded to outrank the editable prompt's standing "flag this" guidance
 * (USD/MYR drag, concentration), which would otherwise re-raise on every new
 * thread what the owner has already settled.
 */
export function buildMemoryContext(memories: readonly string[]): string[] {
  if (memories.length === 0) return []
  return [
    '',
    'OWNER MEMORY (standing positions the owner has already stated; shared by every chat):',
    ...memories.map(m => `- ${m}`),
    '',
    'How to use OWNER MEMORY. This takes precedence over every instruction above that tells you to flag, warn about, caveat or point out a topic, including the currency, FX-drag, diversification and concentration guidance:',
    '- Each line is settled. The owner knows it and has decided. Do not re-flag it, warn about it, add a caveat or reminder about it, lecture on it, or ask the owner to reconsider it. That holds for the first message of a new chat too.',
    '- Raise a topic a line covers only when (a) the owner asks about it in this conversation, or (b) live data shows it has materially changed since: the exposure has moved well past what the line describes, or a new event changes the risk itself. Then say what changed, once and briefly, and do not repeat it later in the conversation.',
    '- Keep using the facts wherever they change the answer: position sizing, currency conversion, weights and risk maths. Leaving a risk unmentioned is not leaving it out of the calculation.',
    '- This changes what you comment on, not how you compute. The currency-arithmetic and trade-safety rules above still apply in full.',
  ]
}
