import { getToolName, isToolUIPart, type ToolSet, type UIMessage } from 'ai'
import type { makeTools } from './tools'

const STOPPED = 'Stopped'

/**
 * Tools whose request changes something outside the chat. Stop only stops
 * waiting: the request is already out, so an order may be placed after the
 * reply said "Stopped".
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set<keyof ReturnType<typeof makeTools>>([
  'trade_place_order', 'trade_propose_order', 'trade_modify_order', 'trade_cancel_order',
  'algo_kill', 'algo_unkill',
  'watchlist_add', 'watchlist_remove',
  'alert_create', 'alert_cancel', 'reminder_create', 'reminder_cancel',
  'research_start', 'planning_update',
])
const STOPPED_WRITE = 'Stopped while the request was in flight. It was already sent, so it may still have gone through: check with trade_orders (or the matching list tool) before retrying.'

const stoppedText = (toolName: string) => WRITE_TOOLS.has(toolName) ? STOPPED_WRITE : STOPPED

function raceAbort<T>(work: PromiseLike<T>, signal: AbortSignal | undefined, stopped: string): PromiseLike<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(stopped))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v) },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e) },
    )
  })
}

/**
 * streamText only notices a stop between chunks, and it waits for a running
 * tool first. Most tools ignore the abort signal, so a slow one would keep the
 * thread busy after Stop. This fails the pending call as soon as the signal fires.
 */
export function stopOnAbort<T extends ToolSet>(tools: T): T {
  const wrapped: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute
    wrapped[name] = execute
      ? {
          ...t,
          execute: (input, options) => {
            const out = execute(input, options)
            return out && typeof (out as PromiseLike<unknown>).then === 'function'
              ? raceAbort(out as PromiseLike<unknown>, options.abortSignal, stoppedText(name))
              : out
          },
        }
      : t
  }
  return wrapped as T
}

/**
 * A stopped reply keeps whatever state its parts were in. Saved as-is, a tool
 * call with no result would render as running forever and, sent back as
 * history, be rejected by the provider. Close every open part instead.
 */
export function settleStoppedParts(parts: UIMessage['parts']): UIMessage['parts'] {
  return parts.map((p) => {
    // Still streaming its input, the call never ran, so nothing was sent.
    if (isToolUIPart(p) && p.state === 'input-streaming') {
      return { ...p, state: 'output-error', input: p.input, errorText: STOPPED }
    }
    if (isToolUIPart(p) && p.state === 'input-available') {
      return { ...p, state: 'output-error', input: p.input, errorText: stoppedText(getToolName(p)) }
    }
    if ((p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming') {
      return { ...p, state: 'done' }
    }
    return p
  })
}
