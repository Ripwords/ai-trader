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
