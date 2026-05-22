// Shared shape for canonical-symbol resolution. Single source of truth for
// the resolver verdict — server (server/lib/yahoo.ts) and client
// (composables/useAgentsRun.ts) both reference this so they can't drift.
// See docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.

export interface SymbolCandidate {
  /** moomoo-style symbol if tradable on moomoo, else null. */
  moomoo: string | null
  yahoo: string
  name: string
  exchange: string
  type: string
}

export type SymbolResolution =
  | { status: 'resolved'; symbol: string; moomoo: string | null; yahoo: string; name: string; exchange: string; quoteType: string }
  | { status: 'ambiguous'; candidates: SymbolCandidate[] }
  | { status: 'not_found' }
  | { status: 'error' }
