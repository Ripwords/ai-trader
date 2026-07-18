export interface PaletteItem { name: string; description: string }

/**
 * Autocomplete filter for the chat slash palette. Active only while the user is
 * still typing the command token (no space yet). Case-insensitive prefix match.
 */
export function filterCommandPalette(input: string, commands: PaletteItem[]): PaletteItem[] {
  if (!input.startsWith('/')) return []
  if (/\s/.test(input)) return []           // args started — stop suggesting
  const token = input.slice(1).toLowerCase()
  return commands.filter(c => c.name.toLowerCase().startsWith(token))
}

/**
 * Wrap an index within [0, len) by `delta`, cycling around the ends.
 * Returns 0 for an empty list so callers can use it unconditionally.
 */
export function cycleIndex(current: number, len: number, delta: number): number {
  if (len <= 0) return 0
  return ((current + delta) % len + len) % len
}

/**
 * Split a chat input into a recognised leading slash-command token and the
 * rest, for highlighting the command inside the input box. `cmd` includes the
 * leading slash (e.g. "/news-pulse") and is non-null only when the token is a
 * KNOWN command name (case-insensitive) — so typos and partial words are not
 * highlighted. `rest` is everything after the token (the args + any spaces).
 */
/** The subset of the textarea's computed style the mirror must copy to stay
 * pixel-aligned. `color` is deliberately NOT part of this — while the
 * highlight is active the textarea's computed color is `transparent`, so
 * copying it would make the mirror's text invisible. Mirror colors are owned
 * by the `.slash-mirror` CSS instead. */
export interface MirrorTextMetrics {
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  fontStyle: string
  lineHeight: string
  letterSpacing: string
  tabSize: string
  textAlign: string
}

export interface MirrorRect { left: number; top: number }

/**
 * Inline style for the slash-highlight mirror: absolutely positioned over the
 * textarea, measured against `hostRect` — the rect of the mirror's POSITIONED
 * ancestor (`.prompt-wrap`), which is what `position: absolute` resolves
 * against. Callers must measure that ancestor directly, never
 * `mirror.offsetParent`: while the mirror is `display: none` its offsetParent
 * is null, and any fallback element measures the wrong box (that's how the
 * mirror once ended up painted on top of the palette).
 */
export function buildMirrorStyle(
  taRect: MirrorRect & { width: number; height: number },
  hostRect: MirrorRect,
  cs: MirrorTextMetrics,
): Record<string, string> {
  return {
    position: 'absolute',
    left: `${taRect.left - hostRect.left}px`,
    top: `${taRect.top - hostRect.top}px`,
    width: `${taRect.width}px`,
    height: `${taRect.height}px`,
    boxSizing: 'border-box',
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
    textAlign: cs.textAlign,
  }
}

export function splitSlashHighlight(
  input: string,
  names: string[],
): { cmd: string | null; rest: string } {
  if (!input.startsWith('/')) return { cmd: null, rest: input }
  const m = input.match(/^\/(\S+)(.*)$/s)
  if (!m) return { cmd: null, rest: input }
  const token = m[1]!
  const known = names.some(n => n.toLowerCase() === token.toLowerCase())
  if (!known) return { cmd: null, rest: input }
  return { cmd: `/${token}`, rest: m[2] ?? '' }
}
