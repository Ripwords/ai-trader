import { describe, it, expect } from 'vitest'
import { filterCommandPalette, cycleIndex, splitSlashHighlight } from '../../app/lib/slash'

const cmds = [
  { name: 'investment-research', description: 'memo' },
  { name: 'investment-team', description: 'lenses' },
  { name: 'news-pulse', description: 'news' },
]

describe('filterCommandPalette', () => {
  it('returns nothing when not a slash input', () => {
    expect(filterCommandPalette('hello', cmds)).toEqual([])
  })
  it('shows all on a bare slash', () => {
    expect(filterCommandPalette('/', cmds)).toHaveLength(3)
  })
  it('prefix-matches the command token, case-insensitively', () => {
    expect(filterCommandPalette('/invest', cmds).map(c => c.name)).toEqual(['investment-research', 'investment-team'])
    expect(filterCommandPalette('/NEWS', cmds).map(c => c.name)).toEqual(['news-pulse'])
  })
  it('stops suggesting once a space (args) is typed', () => {
    expect(filterCommandPalette('/news-pulse 腾讯', cmds)).toEqual([])
  })
})

describe('cycleIndex', () => {
  it('wraps forward past the end', () => {
    expect(cycleIndex(2, 3, 1)).toBe(0)
  })
  it('wraps backward past the start', () => {
    expect(cycleIndex(0, 3, -1)).toBe(2)
  })
  it('moves within bounds normally', () => {
    expect(cycleIndex(0, 3, 1)).toBe(1)
  })
  it('is safe for an empty list', () => {
    expect(cycleIndex(0, 0, 1)).toBe(0)
  })
})

const names = cmds.map(c => c.name)

describe('splitSlashHighlight', () => {
  it('does not highlight plain text', () => {
    expect(splitSlashHighlight('hello world', names)).toEqual({ cmd: null, rest: 'hello world' })
  })
  it('does not highlight an unknown / typo command', () => {
    expect(splitSlashHighlight('/investmnt', names)).toEqual({ cmd: null, rest: '/investmnt' })
  })
  it('highlights a known command and keeps the rest', () => {
    expect(splitSlashHighlight('/news-pulse 腾讯', names)).toEqual({ cmd: '/news-pulse', rest: ' 腾讯' })
  })
  it('matches the command name case-insensitively', () => {
    expect(splitSlashHighlight('/NEWS-PULSE AAPL', names)).toEqual({ cmd: '/NEWS-PULSE', rest: ' AAPL' })
  })
  it('highlights a bare known command with no args', () => {
    expect(splitSlashHighlight('/news-pulse', names)).toEqual({ cmd: '/news-pulse', rest: '' })
  })
})
