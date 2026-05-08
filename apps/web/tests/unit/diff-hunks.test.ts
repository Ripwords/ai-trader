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
