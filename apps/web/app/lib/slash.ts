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
