import { isToolUIPart, type ToolSet, type UIMessage } from 'ai'

const STOPPED = 'Stopped'

function raceAbort<T>(work: PromiseLike<T>, signal: AbortSignal | undefined): PromiseLike<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(STOPPED))
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
              ? raceAbort(out as PromiseLike<unknown>, options.abortSignal)
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
    if (isToolUIPart(p) && (p.state === 'input-streaming' || p.state === 'input-available')) {
      return { ...p, state: 'output-error', input: p.input, errorText: STOPPED }
    }
    if ((p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming') {
      return { ...p, state: 'done' }
    }
    return p
  })
}
