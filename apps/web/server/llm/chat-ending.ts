import type { FinishReason, TextStreamPart, ToolSet } from 'ai'

/**
 * Why a reply that finished without an error still falls short, or null when
 * it does not. A blank bubble or a trailing tool card otherwise gives the user
 * no hint that the answer is missing.
 */
export function incompleteReplyNote(r: {
  finishReason: FinishReason
  answered: boolean
  steps: number
  maxSteps: number
}): string | null {
  switch (r.finishReason) {
    case 'length':
      return 'The reply was cut off at the model\'s output limit.'
    case 'content-filter':
      return 'The provider\'s content filter stopped the reply.'
    case 'tool-calls':
      return r.steps >= r.maxSteps
        ? `Stopped at the step limit (${r.maxSteps} steps) before a final answer. Raise the step limit or ask it to continue.`
        : 'The reply ended after a tool call without a final answer.'
    case 'error':
      return null
    case 'stop':
    case 'other':
      return r.answered ? null : 'The model returned no answer.'
  }
}

/**
 * A `messageMetadata` callback for `toUIMessageStream`: watches the reply go
 * by and puts the note on its finish chunk, so the live view and the saved
 * reply both carry it as `metadata.error`.
 */
export function watchReplyEnding(maxSteps: number) {
  let answered = false
  let steps = 0
  return (part: TextStreamPart<ToolSet>): { error: string } | undefined => {
    if (part.type === 'text-delta' && part.text.trim()) answered = true
    else if (part.type === 'finish-step') steps++
    else if (part.type === 'finish') {
      const error = incompleteReplyNote({ finishReason: part.finishReason, answered, steps, maxSteps })
      return error ? { error } : undefined
    }
    return undefined
  }
}
