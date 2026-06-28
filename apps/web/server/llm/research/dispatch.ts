import { parseSlashCommand } from './commands'

export interface SlashDispatch { toolName: string; directive: string }

export type StepToolChoice = { type: 'tool'; toolName: string } | 'auto'
/** Force the dispatched tool on the first step only; auto thereafter so the model writes prose. */
export function stepToolChoice(toolName: string, stepNumber: number): StepToolChoice {
  return stepNumber === 0 ? { type: 'tool', toolName } : 'auto'
}

/**
 * Map a slash-command message to a deterministic tool dispatch: the tool to
 * force via streamText toolChoice, plus a directive appended to the system
 * prompt that pins the exact arguments. Returns null for natural-language input.
 */
export function slashDispatch(latestUserText: string): SlashDispatch | null {
  const parsed = parseSlashCommand(latestUserText)
  if (!parsed) return null
  const { command, args } = parsed
  const argPairs = Object.entries(args)
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => `${k}="${v}"`)
  const presetPart = command.preset ? `${argPairs.length ? ', ' : ''}preset="${command.preset}"` : ''
  const directive =
    `The user invoked the /${command.name} command. Call the ${command.tool} tool now with ` +
    `${argPairs.join(', ')}${presetPart}. Then write the response from its result following the research-suite guidance.`
  return { toolName: command.tool, directive }
}
