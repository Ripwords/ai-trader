import { describe, expect, it } from 'vitest'
import { buildHunks, resolveCode, summarise } from '../../app/components/algo/diff-hunks'

describe('buildHunks', () => {
  it('returns empty array when base equals proposed', () => {
    expect(buildHunks('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('produces one hunk for a single-line change', () => {
    const hunks = buildHunks('a\nb\nc\n', 'a\nB\nc\n')
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.baseLines).toEqual(['b'])
    expect(hunks[0]!.proposedLines).toEqual(['B'])
    // baseStart points at line 2 (1-indexed) in the base
    expect(hunks[0]!.baseStart).toBe(2)
    expect(hunks[0]!.baseEnd).toBe(3)
  })

  it('produces separate hunks when changed regions are far apart', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n') + '\n'
    const proposed = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'L'].join('\n') + '\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(2)
  })

  it('captures up to 3 lines of context before and after a hunk', () => {
    const base = 'a\nb\nc\nd\nE\nf\ng\nh\ni\n'
    const proposed = 'a\nb\nc\nd\nXX\nf\ng\nh\ni\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.contextBefore).toEqual(['b', 'c', 'd'])
    expect(hunks[0]!.contextAfter).toEqual(['f', 'g', 'h'])
  })

  // Regression: when two changes are within 2*context lines, structuredPatch
  // emits ONE patch hunk that covers both. Previously buildHunks lumped both
  // changes plus the inner context lines into a single Hunk — so the user
  // could only accept-or-reject the whole blob, AND the inner context (b,c,d
  // here) got dropped from resolveCode output.
  it('splits coalesced patch hunks at every contiguous run of changes', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const proposed = 'A\nb\nc\nd\nE\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.baseLines).toEqual(['a'])
    expect(hunks[0]!.proposedLines).toEqual(['A'])
    expect(hunks[0]!.baseStart).toBe(1)
    expect(hunks[1]!.baseLines).toEqual(['e'])
    expect(hunks[1]!.proposedLines).toEqual(['E'])
    expect(hunks[1]!.baseStart).toBe(5)
    // Inner context attaches to both hunks' contextAfter / contextBefore
    expect(hunks[0]!.contextAfter).toEqual(['b', 'c', 'd'])
    expect(hunks[1]!.contextBefore).toEqual(['b', 'c', 'd'])
  })
})

describe('resolveCode', () => {
  it('returns base when all hunks are pending', () => {
    const base = 'a\nb\nc\n'
    const hunks = buildHunks(base, 'a\nB\nc\n')
    expect(resolveCode(base, hunks, new Map())).toBe(base)
  })

  it('returns proposed slice when a hunk is accepted', () => {
    const base = 'a\nb\nc\n'
    const hunks = buildHunks(base, 'a\nB\nc\n')
    const decisions = new Map([[hunks[0]!.id, 'accepted' as const]])
    expect(resolveCode(base, hunks, decisions)).toBe('a\nB\nc\n')
  })

  it('mixes accepted and rejected hunks correctly', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n'
    const proposed = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(2)
    // Accept first, reject second
    const decisions = new Map([
      [hunks[0]!.id, 'accepted' as const],
      [hunks[1]!.id, 'rejected' as const],
    ])
    expect(resolveCode(base, hunks, decisions)).toBe('A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n')
  })

  it('handles a pure insertion hunk', () => {
    const base = 'a\nb\nc\n'
    const proposed = 'a\nNEW\nb\nc\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(1)
    const decisions = new Map([[hunks[0]!.id, 'accepted' as const]])
    expect(resolveCode(base, hunks, decisions)).toBe(proposed)
  })

  it('handles a pure deletion hunk', () => {
    const base = 'a\nb\nc\n'
    const proposed = 'a\nc\n'
    const hunks = buildHunks(base, proposed)
    expect(hunks).toHaveLength(1)
    const decisions = new Map([[hunks[0]!.id, 'accepted' as const]])
    expect(resolveCode(base, hunks, decisions)).toBe(proposed)
  })

  // Regression: with the previous lump-everything-into-one-hunk behaviour,
  // accepting all of a coalesced patch produced a result that was missing
  // the inner context lines (e.g. "A\nE\n" instead of "A\nb\nc\nd\nE\n").
  // The user reported "existing code sometimes don't get removed properly"
  // and accept being "treated as one big edit" — this verifies both.
  it('preserves inner context when both halves of a coalesced patch are accepted', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const proposed = 'A\nb\nc\nd\nE\n'
    const hunks = buildHunks(base, proposed)
    const decisions = new Map([
      [hunks[0]!.id, 'accepted' as const],
      [hunks[1]!.id, 'accepted' as const],
    ])
    expect(resolveCode(base, hunks, decisions)).toBe('A\nb\nc\nd\nE\n')
  })

  it('lets the user accept one half of a coalesced patch and reject the other', () => {
    const base = 'a\nb\nc\nd\ne\n'
    const proposed = 'A\nb\nc\nd\nE\n'
    const hunks = buildHunks(base, proposed)
    const onlyFirst = new Map([
      [hunks[0]!.id, 'accepted' as const],
      [hunks[1]!.id, 'rejected' as const],
    ])
    expect(resolveCode(base, hunks, onlyFirst)).toBe('A\nb\nc\nd\ne\n')
    const onlySecond = new Map([
      [hunks[0]!.id, 'rejected' as const],
      [hunks[1]!.id, 'accepted' as const],
    ])
    expect(resolveCode(base, hunks, onlySecond)).toBe('a\nb\nc\nd\nE\n')
  })
})

describe('summarise', () => {
  it('counts accepted and totals', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n'
    const proposed = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\n'
    const hunks = buildHunks(base, proposed)
    const decisions = new Map([[hunks[0]!.id, 'accepted' as const]])
    expect(summarise(hunks, decisions)).toEqual({ accepted: 1, total: 2 })
  })
})
