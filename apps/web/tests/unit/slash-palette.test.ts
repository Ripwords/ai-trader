import { describe, it, expect } from 'vitest'
import { buildMirrorStyle, filterCommandPalette, cycleIndex, splitSlashHighlight } from '../../app/lib/slash'

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

describe('buildMirrorStyle', () => {
  const taRect = { left: 110, top: 253, width: 704, height: 32 }
  // Host = the positioned ancestor the absolute mirror resolves against
  // (prompt-wrap). With the palette open its top sits ABOVE the textarea.
  const hostRect = { left: 100, top: 208 }
  const cs = {
    paddingTop: '6px', paddingRight: '10px', paddingBottom: '6px', paddingLeft: '10px',
    fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', fontStyle: 'normal',
    lineHeight: '20px', letterSpacing: 'normal', tabSize: '4', textAlign: 'start',
    color: 'rgba(0, 0, 0, 0)',
  }

  it('positions the mirror at the textarea offset within the host', () => {
    const s = buildMirrorStyle(taRect, hostRect, cs)
    expect(s.position).toBe('absolute')
    expect(s.left).toBe('10px')
    expect(s.top).toBe('45px') // 253 - 208: below the palette, never on it
    expect(s.width).toBe('704px')
    expect(s.height).toBe('32px')
  })

  it('copies the text metrics needed for pixel alignment', () => {
    const s = buildMirrorStyle(taRect, hostRect, cs)
    expect(s.fontFamily).toBe('Inter')
    expect(s.fontSize).toBe('16px')
    expect(s.lineHeight).toBe('20px')
    expect(s.paddingLeft).toBe('10px')
  })

  it('never copies color — the textarea is transparent while highlighted', () => {
    // Regression: copying cs.color captured `transparent` and made the args
    // after the command invisible. The mirror's colors are CSS-owned.
    const s = buildMirrorStyle(taRect, hostRect, cs)
    expect(s).not.toHaveProperty('color')
    expect(s).not.toHaveProperty('display')
  })
})
