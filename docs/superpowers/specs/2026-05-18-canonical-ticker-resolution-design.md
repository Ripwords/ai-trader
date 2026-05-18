# Canonical Ticker Resolution — Design

**Date:** 2026-05-18
**Status:** Approved (pending spec review)

## Problem

A research run for `US.MU` (moomoo format: US market + symbol `MU` =
**Micron Technology**) produced a "BUY" verdict written as if the company were
**Munich Re**. The symbol flows end-to-end as a raw string:
`create_initial_state(symbol, …)` hands the tradingagents prompts only
`US.MU`, every toolkit result is labelled `"News for US.MU"`, and the news
provider receives `US.MU` as a free-text query. Nothing in the pipeline ever
asserts "this ticker is Micron Technology", so the LLM filled the gap with a
hallucinated company.

Yahoo search already returns the correct company name for `MU`
(`searchSymbols()` in `apps/web/server/lib/yahoo.ts`), but that name is used
only for the autocomplete dropdown and discarded after selection.

## Goals

- Force every covered service to operate on a Yahoo-resolved canonical symbol.
- Carry the resolved company name to the LLM agents and the news search so the
  model anchors on the correct company.
- Fail closed: an ambiguous or unresolvable symbol blocks the run with a clear
  "pick the right instrument" prompt — never a silent guess.

## Scope

In scope (per user decision):

- **Research pipeline** — hard gate at UI entry + company name carried into
  agent tool outputs and the news query.
- **Algo strategies** — resolve/validate symbol on strategy create/edit.
- **Quote / news direct APIs** — resolve at the boundary.

Out of scope (explicitly excluded by user): chat tools (natural-language entry
already has hardcoded moomoo mappings in `moomoo-context.ts`).

## Architecture

Single canonical resolver lives in `apps/web/server/lib/yahoo.ts` and is
exposed as one internal HTTP endpoint. Web is the only place with working
Yahoo access (Python's yfinance host is datacenter-blocked, per project
constraint). Every covered service resolves through this one endpoint —
single source of truth.

Optimization: the Nuxt research proxy resolves once and persists the resolved
`company_name` onto the run row, so the Python side gets it via `RunRequest`
without an extra round trip; it falls back to the resolve endpoint only if the
field is absent (keeps the API safe when called directly).

## Components

### 1. Resolver core — `apps/web/server/lib/yahoo.ts`

`resolveSymbol(input: string): Promise<SymbolResolution>`

- Normalizes input (accepts `MU`, `US.MU`, `us.mu`).
- Runs the existing `yahoo.search()`, maps results via existing
  `fromYahooSymbol()`.
- Returns a discriminated union:
  - `{ status: 'resolved', moomoo, yahoo, name, exchange, quoteType }`
  - `{ status: 'ambiguous', candidates: SymbolSearchResult[] }`
  - `{ status: 'not_found' }`
  - `{ status: 'error' }` — Yahoo unreachable / network failure.
- **Confident-match rule:** an exact case-insensitive ticker hit with
  `quoteType === 'EQUITY'` on a supported exchange wins outright. Otherwise →
  `ambiguous` with the top candidates. This is what prevents a wrong-instrument
  silent pick.
- Results cached in-process keyed by normalized input, reusing the TTL/cache
  pattern of the existing yahoo helpers.

### 2. Resolve endpoint

`GET /api/internal/symbol/resolve?q=…` → returns the `SymbolResolution` union.
Lives in the `/api/internal/*` namespace (same as the `/api/internal/yahoo/*`
endpoints the Python toolkit already calls — no session cookie required,
unlike `/api/*`). The existing `/api/research/symbol-search` is unchanged and
continues to back the autocomplete.

### 3. Research hard gate

- **`SymbolSearchInput.vue` / `research/index.vue`:** submit enabled only when
  a result is *selected* from the dropdown. Selection carries
  `{ moomoo, name }`. A free-typed Enter triggers a resolve: `resolved` →
  proceed; `ambiguous`/`not_found`/`error` → expand the picker / show message,
  no navigation.
- **`research/[symbol].vue`** (deep link / refresh): resolve the route param
  on load. `resolved` → run with the canonical symbol; otherwise render a
  "pick the right instrument" state instead of starting a run.
- **Nuxt proxy `agents-run.post.ts`:** re-resolves server-side (defense in
  depth), writes canonical `symbol` + new `company_name` into the
  `agent_runs` row, forwards both to FastAPI. Unresolved → HTTP 422, run never
  starts.
- **`RunRequest` schema (`apps/api/app/schemas/agents.py`):** add
  `company_name: str | None`. The API treats `symbol` as already canonical; if
  `company_name` is missing it calls `/api/internal/symbol/resolve` itself
  before the graph starts.

### 4. Python agent injection (the hallucination fix)

- `graph.py`: thread `company_name` into `run_graph`; inject into the
  per-run toolkit closure.
- `toolkit.py`: prefix every tool result with the canonical identity —
  `"News for Micron Technology, Inc. (US.MU): …"` instead of
  `"News for US.MU"`. Same for fundamentals / stock-data / balance sheet /
  cashflow / income statement / insider transactions.
- `get_news` query becomes `"{company_name} {moomoo}"`
  (e.g. `"Micron Technology, Inc. US.MU"`) so the search provider itself
  returns the right company's news — closing the loop at the data layer, not
  just the prompt.

### 5. Algo strategies & direct APIs

- Strategy create/edit: resolve symbol at the write boundary; store canonical
  `{symbol, company_name}`. `ambiguous`/`not_found`/`error` → validation error.
- `/quote/*` and `/api/internal/news/*`: resolve at the boundary; an
  unresolvable input returns a structured error rather than a guess.

## Error Handling

- Yahoo unreachable / network error → resolver returns `status: 'error'`.
- All callers **fail closed**: block the run / reject the request with a clear
  message. No service proceeds on an unresolved raw symbol.

## Testing (TDD)

Tests written before implementation, per project conventions:

- Resolver unit tests: `US.MU` → Micron `resolved`; an intentionally
  ambiguous query → `ambiguous`; junk input → `not_found`; simulated Yahoo
  failure → `error`.
- Proxy test: an unresolved symbol returns 422 and never reaches FastAPI.
- Toolkit tests: tool outputs carry the company name; the `get_news` query
  string includes the company name.

## Out of Scope / YAGNI

- No persistent ticker registry/DB table — in-process cache is sufficient.
- No change to chat tools.
- No change to the tradingagents library prompts (injection is done entirely
  in code we own: the toolkit outputs and the news query).
