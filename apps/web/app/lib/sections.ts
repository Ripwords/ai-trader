export interface Section {
  key: 'chat' | 'research' | 'portfolio' | 'algo' | 'usage'
  to: string
  label: string
  // One-line blurb shown in the mobile drawer; never on desktop.
  blurb: string
}

export const SECTIONS: readonly Section[] = [
  { key: 'chat',      to: '/',          label: 'chat',      blurb: 'copilot — charts, news, paper writes' },
  { key: 'research',  to: '/research',  label: 'research',  blurb: 'analyst signals + investor personas' },
  { key: 'portfolio', to: '/portfolio', label: 'portfolio', blurb: 'cross-broker net worth' },
  { key: 'algo',      to: '/algo',      label: 'algo',      blurb: 'strategies, backtests, scheduler' },
  { key: 'usage',     to: '/usage',     label: 'usage',     blurb: 'LLM tokens & cost' },
] as const

/** Resolve which section the current path belongs to. Longest-prefix wins
 *  so `/research/compare` correctly highlights `research`. The chat
 *  section (`/`) only matches an exact `/`. */
export function activeSectionKey(path: string): Section['key'] {
  const exact = SECTIONS.find(s => s.to === path)
  if (exact) return exact.key
  const prefix = SECTIONS
    .filter(s => s.to !== '/' && path.startsWith(`${s.to}/`))
    .sort((a, b) => b.to.length - a.to.length)[0]
  return prefix?.key ?? 'chat'
}
