# Contextual News Retrieval — Design

**Date:** 2026-05-19
**Status:** Approved (pending spec review)

## Problem

News retrieval is narrowly ticker-scoped, so analysis misses the macro and
sector catalysts that actually drive price moves.

- **Chat** (`apps/web/server/llm/tools.ts`): `search_news` is a single generic
  tool. In practice the model queries only the ticker, so nothing macro comes
  back.
- **Research agents** (`apps/api/app/services/agents/toolkit.py`): `get_news`
  is hard-anchored to `"<company> <ticker>"` against `/internal/news/symbol`.
  A separate `get_global_news` fires a fixed `"global macroeconomic news"`
  query — too generic to surface specific catalysts (e.g. a Fed chair change,
  a bond-yield spike), and the News Analyst node may not call it at all.

Symptom: asking "why did stock X drop" yields ticker-only headlines; drivers
like a Fed leadership change or rate-fear selloff never enter the analysis.

## Goals

Every ticker news fetch also returns the macro, sector, and peer news that
explains *why* the stock moved, via one shared implementation reused by both
the chat tool and the Python research agents.

Coverage required on every fetch (user-confirmed): rates & monetary policy;
broad market & indices; sector & peers; geopolitics & commodities.

## Approach (decided)

Hybrid: an **always-on deterministic macro baseline** plus **always-on
LLM-derived ticker-specific angles**, both implemented in the **shared web
news layer** so chat and research agents benefit identically.

## Architecture

New module `apps/web/server/lib/contextual-news.ts` exposing:

```ts
getContextualNews({ symbol, companyName?, maxResults? }):
  Promise<{ ticker: NewsResult[]; macro: NewsResult[]; contextual: NewsResult[] }>
```

`NewsResult` is the existing type from `apps/web/server/lib/search.ts`.

### Fetch layers (two waves)

**Wave 1 (parallel):**

1. **Ticker** — `searchWithFallback('news', "<company> <ticker>", maxResults)`.
   Unchanged from today's behavior.
2. **Deterministic macro** — fixed queries, identical for every ticker and
   user (so cacheable):
   - `"Federal Reserve interest rate decision FOMC inflation"`
   - `"US stock market today S&P 500 Nasdaq selloff rally bond yields"`

   Covers *rates & monetary policy* + *broad market & indices*.
3. **Angle derivation** — one `generateObject` call via `buildModel()`
   (`apps/web/server/llm/model.ts`). Input: ticker, company, sector (if
   known). Output (Zod-validated `{ queries: string[] }`): 2–4 short search
   queries covering *sector & peers* and *relevant geopolitics & commodities*
   (e.g. NVDA → `"semiconductor export controls China"`,
   `"AMD Nvidia AI chip demand"`).

**Wave 2 (parallel):** run the derived angle queries → `contextual` group.

The deterministic macro layer (2) covers the two generic categories; the
LLM-derived layer (3) covers the two inherently ticker-specific categories.
Together they satisfy the four required categories on every call. Derivation
always runs (non-optional hybrid).

### Merge

- Dedupe by URL across all groups; ticker wins ties, then macro, then
  contextual.
- Per-group caps: `ticker ≤ maxResults`, `macro ≤ 4`, `contextual ≤ 6`.
- Each returned item retains its group so callers can attribute drivers.

### Caching

In-memory TTL cache (~10 min) keyed by the deterministic macro query string
only (no ticker/user). Avoids re-hitting Brave/Tavily on every news call and
reduces latency. Best-effort: a miss just triggers a fresh fetch.

### Failure isolation

Every search and the LLM call are independent. If derivation fails →
ticker + macro still returned. If a provider key is missing → existing
`searchWithFallback` fallback applies; macro/contextual resolve empty.

## Call sites & data flow

### Chat (`apps/web/server/llm/tools.ts`)

- `search_news` stays unchanged (general-purpose, non-ticker topic search).
- Add new tool `ticker_news_context`:
  - description: gets stock news **plus** the macro/sector/peer news that
    explains why it moved; instruct the model to prefer it over `search_news`
    for any stock "why did X move" / ticker news-analysis question.
  - input: `{ symbol: string; companyName?: string; maxResults?: number }`
  - execute: `getContextualNews(...)`, returns the three labeled groups.

### Research agents (`apps/api/app/services/agents/toolkit.py`)

- Add bearer-guarded route
  `apps/web/server/api/internal/news/contextual.get.ts` →
  `getContextualNews(...)` (same guard pattern as `symbol.get.ts` /
  `global.get.ts`).
- Update `toolkit.get_news` to call `/api/internal/news/contextual` instead
  of `/api/internal/news/symbol`, and flatten the three groups into its
  returned markdown with group headers (Ticker / Macro / Sector & Peers) so
  the News Analyst node sees macro context inline. No agent prompt changes
  needed (the tool is hard-anchored).
- `get_global_news` and `/internal/news/global` are unchanged (other nodes
  still use them) but are no longer the only macro-context source.

### Flow

```
caller → getContextualNews(symbol, company)
   ├─ wave1: ticker search ───────────┐
   ├─ wave1: macro search (cached) ───┤→ merge+dedupe+cap+tag → grouped result
   └─ wave1: LLM angle-derive → wave2: contextual searches ─┘
```

## Error handling

- Each layer wrapped independently; a rejected search or LLM call resolves to
  `[]` for that group, never throws upward.
- Angle-derivation: `generateObject` in try/catch; validate output with Zod
  `{ queries: string[] }`, clamp to ≤ 4, drop empty strings; failure →
  empty `contextual` + warning log.
- No provider keys → today's behavior; ticker group carries the existing
  `error` field, macro/contextual empty.
- Cache miss/stale → fresh fetch; no failure path.

## Testing (TDD — tests first)

**`apps/web` (vitest)** — `getContextualNews` with `searchWithFallback` and
`buildModel`/`generateObject` mocked:

- merges three groups, dedupes by URL (ticker wins), respects per-group caps
- LLM-derive failure → ticker + macro still returned
- all-providers-missing → graceful empty groups + preserved error
- macro cache hit avoids a second provider call within TTL

**`apps/api` (pytest)** — extend `tests/agents/test_toolkit.py`:

- `get_news` calls `/internal/news/contextual` and renders grouped headers
- existing "search failure" and "no company name" cases pass against the new
  route

## Edge cases

- No `companyName` → ticker query falls back to bare symbol (current
  behavior); derivation still runs on the symbol alone.
- Sector unknown → derivation prompt omits the sector line; LLM still
  produces peer/geopolitics angles from ticker + company.
- Small `maxResults` (e.g. 3) → ticker respects it; macro/contextual keep
  their own small caps so context is not starved.

## Out of scope

- Changing `search_news` behavior or the existing `/internal/news/symbol`
  and `/internal/news/global` routes.
- Per-ticker peer resolution as a separate service (handled by LLM angle
  derivation instead).
- Agent graph / prompt restructuring beyond the `get_news` route swap.
