import { structuredPatch } from 'diff'

/**
 * Pure module powering the editor's diff-review mode.
 *
 * Given a `base` (the user's draft at chat-handoff time) and `proposed`
 * (assistant's suggestion), `buildHunks` produces an ordered list of
 * `Hunk`s. Each hunk has stable id, the base/proposed lines, and up to 3
 * lines of context on either side.
 *
 * `resolveCode` walks the base line-by-line and emits proposed lines for
 * accepted hunks and base lines for everything else (pending hunks treated
 * as rejected). `summarise` is the toolbar counter helper.
 */

export interface Hunk {
  id: string
  baseStart: number
  baseEnd: number
  baseLines: string[]
  proposedLines: string[]
  contextBefore: string[]
  contextAfter: string[]
}

export type HunkDecision = 'pending' | 'accepted' | 'rejected'

export interface DiffPayload {
  blockKey: string
  base: string
  proposed: string
  hunks: Hunk[]
}

/**
 * Build a list of hunks from base→proposed using `diff.structuredPatch`.
 *
 * `structuredPatch` emits hunks where each line is prefixed with one of
 * ' ' (context), '-' (removed from base), '+' (added in proposed). We
 * partition those lines into context-before / changed / context-after by
 * scanning until the first non-space marker, collecting changes, and then
 * collecting trailing space-prefixed lines as context-after.
 *
 * `baseStart` is 1-indexed in base and points at the first removed line.
 * If a hunk is a pure insertion (no `-` lines), `baseStart` points at the
 * line *after* the leading context (the insertion point).
 */
export function buildHunks(base: string, proposed: string): Hunk[] {
  const patch = structuredPatch('a', 'b', base, proposed, '', '', { context: 3 })
  const out: Hunk[] = []

  for (let i = 0; i < patch.hunks.length; i++) {
    const h = patch.hunks[i]!
    const lines = h.lines

    // Find leading context (pure ' ' lines), then the changed block, then
    // trailing context.
    let leadIdx = 0
    while (leadIdx < lines.length && lines[leadIdx]!.startsWith(' ')) leadIdx++

    let trailStart = lines.length
    while (trailStart > leadIdx && lines[trailStart - 1]!.startsWith(' ')) trailStart--

    const contextBefore = lines.slice(0, leadIdx).map(stripMarker)
    const contextAfter = lines.slice(trailStart).map(stripMarker)
    const changed = lines.slice(leadIdx, trailStart)

    const baseLines: string[] = []
    const proposedLines: string[] = []
    for (const ln of changed) {
      if (ln.startsWith('-')) baseLines.push(stripMarker(ln))
      else if (ln.startsWith('+')) proposedLines.push(stripMarker(ln))
      // ' ' inside a changed block shouldn't happen with context=3 splitting
      // far-apart hunks, but if it does we treat it as context lost — skip.
    }

    // baseStart in base = oldStart + leading-context-count.
    const baseStart = h.oldStart + leadIdx
    const baseEnd = baseStart + baseLines.length

    out.push({
      id: `h${i}`,
      baseStart,
      baseEnd,
      baseLines,
      proposedLines,
      contextBefore: contextBefore.slice(-3),
      contextAfter: contextAfter.slice(0, 3),
    })
  }

  return out
}

function stripMarker(line: string): string {
  // structuredPatch lines are prefixed with one marker char.
  return line.length > 0 ? line.slice(1) : line
}

/**
 * Walk the base line array. At each hunk's `baseStart - 1`, either splice
 * in `proposedLines` (accepted) or keep `baseLines` (pending/rejected),
 * advancing the cursor by `baseLines.length` either way.
 *
 * Preserves trailing newline behaviour of base.
 */
export function resolveCode(
  base: string,
  hunks: Hunk[],
  decisions: Map<string, HunkDecision>,
): string {
  const baseEndsWithNewline = base.endsWith('\n')
  const baseLines = baseEndsWithNewline
    ? base.slice(0, -1).split('\n')
    : base.split('\n')

  // Sort hunks by baseStart so we can walk forward.
  const sorted = [...hunks].sort((a, b) => a.baseStart - b.baseStart)

  const out: string[] = []
  let cursor = 0  // 0-indexed cursor into baseLines

  for (const h of sorted) {
    const startIdx = h.baseStart - 1  // convert to 0-indexed

    // Emit base lines up to the hunk start.
    while (cursor < startIdx) {
      out.push(baseLines[cursor]!)
      cursor++
    }

    const decision = decisions.get(h.id) ?? 'pending'
    if (decision === 'accepted') {
      for (const ln of h.proposedLines) out.push(ln)
    } else {
      for (const ln of h.baseLines) out.push(ln)
    }
    // Skip past the base lines this hunk covers (regardless of decision).
    cursor += h.baseLines.length
  }

  // Drain remaining base lines.
  while (cursor < baseLines.length) {
    out.push(baseLines[cursor]!)
    cursor++
  }

  return out.join('\n') + (baseEndsWithNewline ? '\n' : '')
}

export function summarise(
  hunks: Hunk[],
  decisions: Map<string, HunkDecision>,
): { accepted: number; total: number } {
  let accepted = 0
  for (const h of hunks) {
    if (decisions.get(h.id) === 'accepted') accepted++
  }
  return { accepted, total: hunks.length }
}
