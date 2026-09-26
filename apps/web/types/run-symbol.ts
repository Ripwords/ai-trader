/**
 * Runs are stored under the resolved symbol (moomoo's `US.AAPL`), while the
 * research URL carries whatever the user typed (`AAPL`).
 */
export function runSymbolPattern(requested: string): string {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `^([A-Z]{2}\\.)?${escaped}$`
}

export function runSymbolMatches(stored: string, requested: string): boolean {
  return new RegExp(runSymbolPattern(requested)).test(stored)
}
