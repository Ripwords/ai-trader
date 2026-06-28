import { describe, it, expect } from 'vitest'
import { filterCommandPalette } from '../../app/lib/slash'

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
