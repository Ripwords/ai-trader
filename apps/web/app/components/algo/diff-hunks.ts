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
 * `structuredPatch` emits "patch hunks" where each line is prefixed with
 * one of ' ' (context), '-' (removed from base), '+' (added in proposed).
 * Crucially, when two changed regions are within 2*context lines of each
 * other, structuredPatch coalesces them into the SAME patch hunk — so a
 * single returned hunk can contain multiple distinct edits separated by
 * inner context lines.
 *
 * For per-hunk accept/reject UX we want each contiguous run of '-'/'+'
 * lines to be its own user-decidable Hunk. So we walk each patch hunk and
 * split at every run boundary; inner context lines stay as context, never
 * as part of any change.
 *
 * `baseStart` is 1-indexed in base and points at the first base line the
 * change covers. For a pure insertion (no '-' lines), `baseStart` is the
 * insertion point — the line *before which* the new lines should appear.
 */
export function buildHunks(base: string, proposed: string): Hunk[] {
  const patch = structuredPatch('a', 'b', base, proposed, '', '', { context: 3 })
  const out: Hunk[] = []
  let counter = 0

  for (const h of patch.hunks) {
    const lines = h.lines
    let baseLineNum = h.oldStart  // 1-indexed cursor into base
    let i = 0

    while (i < lines.length) {
      // Skip context lines until we hit the start of a changed run.
      while (i < lines.length && lines[i]!.startsWith(' ')) {
        baseLineNum++
        i++
      }
      if (i >= lines.length) break

      // Collect up to 3 context lines immediately preceding this run.
      const contextBefore: string[] = []
      for (let j = i - 1; j >= 0 && contextBefore.length < 3; j--) {
        if (!lines[j]!.startsWith(' ')) break
        contextBefore.unshift(stripMarker(lines[j]!))
      }

      // Collect the contiguous run of '-' and '+' lines.
      const runStart = baseLineNum
      const baseLines: string[] = []
      const proposedLines: string[] = []
      while (i < lines.length && !lines[i]!.startsWith(' ')) {
        const ln = lines[i]!
        if (ln.startsWith('-')) {
          baseLines.push(stripMarker(ln))
          baseLineNum++  // '-' consumes a base line
        } else if (ln.startsWith('+')) {
          proposedLines.push(stripMarker(ln))
          // '+' consumes nothing in base
        }
        i++
      }

      // Collect up to 3 context lines immediately following this run
      // (without consuming them — they may be the contextBefore of the
      // next run).
      const contextAfter: string[] = []
      for (let j = i; j < lines.length && contextAfter.length < 3; j++) {
        if (!lines[j]!.startsWith(' ')) break
        contextAfter.push(stripMarker(lines[j]!))
      }

      out.push({
        id: `h${counter++}`,
        baseStart: runStart,
        baseEnd: runStart + baseLines.length,
        baseLines,
        proposedLines,
        contextBefore,
        contextAfter,
      })
    }
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
