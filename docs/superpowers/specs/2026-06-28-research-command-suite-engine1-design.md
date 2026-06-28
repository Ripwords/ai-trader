# Research Command Suite — Engine 1 (deep-research memo) + Engine 6 (retrievers)

**Date:** 2026-06-28
**Status:** Approved (design), pending implementation plan

## Context

The user wants an in-app "investment research" command suite in the ai-trader web
chat. The full ask spans ~18 slash-commands across five categories. During
brainstorming we established that these are not 18 independent features but a
handful of **engines**, most commands being thin presets over an engine. The
suite is decomposed into separate spec → plan → build cycles:

- **Engine 1** — single-company deep-research memo (this spec)
- **Engine 2** — earnings review (quantitative only; transcripts MISSING)
- **Engine 3** — multi-ticker checklist / compare
- **Engine 4** — screening over a universe (BLOCKED: no index constituents / bulk fundamentals)
- **Engine 5** — qualitative web-research orchestration (private companies, industries)
- **Engine 6** — lightweight retrievers (this spec, rides along with Engine 1)

**This spec covers Engine 1 + Engine 6 only.** The other engines are out of scope
here and will get their own specs.

## Goals

Deliver these commands in the web chat, each invokable **two ways** — by natural
language (the model auto-selects the tool) AND by an explicit slash-command:

- `/investment-research <ticker>` — standard sectioned research memo
- `/investment-team <ticker>` — same memo, multi-lens (bull/bear/quant/macro) emphasis
- `/deep-company-series <ticker>` — long-form memo with optional multi-part continuation
- `/management-deep-dive <person> <ticker>` — management/capital-allocation focus + targeted web bio
- `/news-pulse <ticker>` — grouped news digest
- `/thesis-tracker <ticker>` — read-only run history / verdict / aging / realized alpha
- `/dyp-ask <question>` — first-principles reasoning answer to a pointed question

## Non-goals (YAGNI)

- Engines 2–5 (earnings, checklist, screening, qualitative web orchestration).
- A new `thesisNotes` table — `/thesis-tracker` is **read-only** over existing data.
- Fresh agents runs or deep web fan-out **by default** — memo uses the **Fast
  profile** (reuse existing data) and offers to deepen on demand.
- Earnings-call transcripts (no data source).
- A separate tool per memo preset — the four memo commands share ONE tool.

## Decisions locked during brainstorming

1. **Invocation:** both natural-language (LLM-invoked tools) AND a deterministic
   slash-command palette. Same tool logic under both.
2. **Engine 1 nature:** a NEW orchestration producing a sectioned research memo;
   the agents pipeline is ONE input (latest verdict), not the whole output.
3. **Memo depth:** Fast profile by default (no blocking on fresh agents runs, no
   web fan-out — except management-deep-dive's single targeted bio search).
4. **Presets:** the 4 memo commands are config over one engine/tool.
5. **dyp-ask:** first-principles reasoning answer (no persona).
6. **thesis-tracker:** read-only.

## Existing capabilities reused (capability scan)

- Fundamentals: `apps/web/server/lib/yahoo.ts` — `getFinancialMetrics`,
  `getHistorical` (annual), `getQuarterlyHistory`, `getEarningsInfo`,
  `getInsiderTrades`, `resolveSymbol`.
- Valuation: `GET /api/research/valuation?symbol=` → DCF + scenarios + reverse-DCF
  + multiples + veto + `data_quality` (backed by `apps/api/.../valuation/compose.py`).
- Agents verdict: `research_get` tool / `getLatestRunForSymbol` +
  `getRunAssessment` in `apps/web/server/lib/agents/runs-query.ts` (built in the
  prior slice); `research_start` to deepen.
- News: `getContextualNews` (`apps/web/server/lib/contextual-news.ts`) /
  `ticker_news_context` tool — grouped ticker / macro / contextual news.
- Web search: `searchWithFallback` (`apps/web/server/lib/search.ts`, Brave→Tavily).
- Thesis data: `agentRuns`/`agentDecisions`/`agentReflections` +
  `buildResearchIntelligence` (`apps/web/server/lib/research-intelligence.ts`).
- Chat: `streamText` (Vercel AI SDK) in `apps/web/server/api/chat.post.ts`,
  tools in `apps/web/server/llm/tools.ts`, system prompt in
  `apps/web/server/llm/chat-context.ts`. Tools self-fetch internal APIs forwarding
  the `session` cookie via `getCookie(options.event, 'session')`.

## Design

### Layer A — capability tools

Four new tools in `tools.ts`, following the existing `tool({ description,
inputSchema, execute })` pattern. They self-fetch internal APIs forwarding the
session cookie. Each returns a **structured payload**; the chat LLM composes the
prose from it (the assistant message IS the memo/answer). Existing cards (e.g.
valuation) render inline from the structured sub-parts.

- `investment_research({ symbol, preset, person?, part? })`
  - `preset ∈ 'research' | 'team' | 'series' | 'management'` (default `'research'`).
  - Calls `buildResearchDossier(symbol, { preset, person, part })`, returns the
    `ResearchDossier`.
- `news_pulse({ symbol })` → grouped news digest from `getContextualNews`.
- `thesis_tracker({ symbol })` → read-only thesis summary (see below).
- `dyp_ask({ question, symbol? })` → light context bundle for first-principles
  answer (see below).

### The memo engine — `buildResearchDossier`

`apps/web/server/llm/research/dossier.ts`:

```ts
export interface DossierSection<T> { ok: boolean; note?: string; data: T | null }
export interface ResearchDossier {
  symbol: string
  companyName: string
  preset: 'research' | 'team' | 'series' | 'management'
  part?: number
  valuation: DossierSection<unknown>      // /api/research/valuation payload
  fundamentals: DossierSection<unknown>   // metrics + annual + quarterly + earnings
  insider: DossierSection<unknown>
  news: DossierSection<unknown>           // grouped contextual news
  agentsVerdict: DossierSection<unknown>  // latest run: rating/confidence/rationale, or note "no recent run"
  managementWeb?: DossierSection<unknown> // only when preset==='management': targeted web bio search
  dataQuality: { full: boolean; missing: string[] }
}
export async function buildResearchDossier(
  symbol: string,
  opts: { preset: ResearchDossier['preset']; person?: string; part?: number; event?: H3Event },
): Promise<ResearchDossier>
```

- Resolves the symbol first (`resolveSymbol`); on non-resolved, the tool surfaces
  the 422 picker verdict (reuse existing pattern), it does not fabricate.
- Gathers Fast-profile inputs **in parallel** (`Promise.allSettled`) so one slow
  or failing source degrades gracefully into a `DossierSection{ ok:false, note }`
  rather than failing the memo.
- `agentsVerdict`: latest non-running run via `getLatestRunForSymbol` +
  `getRunAssessment`; if none/stale, `ok:false, note:'no recent agents run — say
  "run the agents" to add a fresh verdict'`.
- `management` preset: one `searchWithFallback` query for the person's track
  record / capital allocation; failure → note + continue.
- `dataQuality.missing` lists sections that came back empty so the memo can be
  honest about gaps.

The chat LLM writes the memo from the dossier using a **section template** in the
system prompt (see Layer C). Preset shapes the template emphasis:

- `research` — 7 sections: Business & moat · Financials · Valuation · Bull/Bear ·
  Risks · Management · Verdict.
- `team` — same data, prompt instructs explicit bull / bear / quant / macro lens
  treatment.
- `series` — long-form; if `part` provided, the prompt continues the series from
  that part. **v1 pragmatic scope:** ships as a long one-shot memo with an
  optional `part` continuation hint; true stateful multi-part is not required for v1.
- `management` — emphasizes founder/management track record, capital allocation,
  alignment; weaves in `managementWeb`.

### Engine 6 retrievers

- `news_pulse` — calls `getContextualNews(symbol)`; returns the three groups; LLM
  writes a short digest. Reuses any existing news rendering.
- `thesis_tracker` — `apps/web/server/llm/research/thesis.ts`:
  `buildThesisSummary(userId, symbol)` reads `agentRuns` + `agentDecisions` +
  `agentReflections` (+ `buildResearchIntelligence`) and returns:
  ```ts
  export interface ThesisSummary {
    symbol: string
    latest: { runId: string; rating: string | null; confidence: number | null; finishedAt: string | null } | null
    history: Array<{ runId: string; rating: string | null; confidence: number | null; finishedAt: string | null }>
    confidenceTrend: 'up' | 'down' | 'flat' | 'n/a'
    staleness: 'fresh' | 'stale' | 'none'   // >21d = stale (matches research-intelligence)
    realizedAlpha: number | null            // from agentReflections (overall role) if present
  }
  ```
  Owner-scoped. Read-only.
- `dyp_ask` — `apps/web/server/llm/research/dyp.ts`:
  `gatherDypContext({ question, symbol? })` extracts a ticker if present
  (reuse `extractTickerCandidates` from the prior slice's `recall.ts`), pulls a
  light bundle (fundamentals + valuation + news for that ticker), returns it. The
  LLM answers via the dyp template (decompose → evidence → steelman → counter →
  conclusion → what-would-change-my-mind). If no ticker, answers from reasoning +
  optional web search.

### Layer B — slash-command palette + deterministic dispatch

- `apps/web/server/llm/research/commands.ts` — the **command registry**, a single
  serializable source of truth shared by server dispatch and the client palette:
  ```ts
  export interface SlashCommand {
    name: string            // 'investment-research'
    tool: string            // 'investment_research'
    description: string
    args: Array<{ name: string; kind: 'symbol' | 'person' | 'text'; required: boolean }>
    preset?: string         // for memo presets
  }
  export const SLASH_COMMANDS: SlashCommand[]
  export function parseSlashCommand(text: string): { command: SlashCommand; args: Record<string, string> } | null
  ```
  `parseSlashCommand` handles `/investment-research 腾讯`,
  `/management-deep-dive 王兴 美团` (person + symbol), `/dyp-ask <free text>` (rest
  of line as `question`); returns `null` for unknown/non-slash input.
- **Client palette:** the chat input detects a leading `/`, shows an autocomplete
  menu from a `GET /api/chat/commands` endpoint (returns `SLASH_COMMANDS`). On
  send, the client includes the raw text (the server re-parses authoritatively).
- **Server dispatch (`chat.post.ts`):** if the latest user message parses as a
  slash command, force its tool via the AI SDK's `toolChoice: { type: 'tool',
  toolName }` and pass the parsed args (mapped into the tool call). The model then
  streams the memo/answer prose from the tool result. Natural-language messages
  leave `toolChoice` at default (auto) so tools are LLM-selected as today.
- Parsed args reach the tool by appending a single normalized instruction line to
  the model messages (e.g. `Run investment_research for symbol=US.700 preset=team`)
  alongside the forced `toolChoice` — deterministic tool, correct args, no extra
  schema needed. (Plan will pin the exact wiring against the AI SDK version in use.)

### Layer C — system prompt additions (`chat-context.ts`)

Add, gated to keep tokens bounded:

- A **memo section template** per preset (the 7 sections; lens/series/management
  variations), instructing: write from the dossier, cite the agents' verdict when
  present, never invent missing data, render the valuation card inline, footer
  offering to deepen (fresh agents run / deep web).
- A **dyp-ask template** (decompose → evidence → steelman → counter → conclusion →
  what-would-change-my-mind).
- Brief notes that `news_pulse` / `thesis_tracker` outputs should be summarized,
  not restated verbatim.
- One line listing the slash commands so NL users discover them.

## Data flow

```
/investment-research 腾讯 team
  client palette parses → sends raw text
  chat.post.ts: parseSlashCommand → force toolChoice investment_research
    → investment_research({symbol, preset:'team'})
      → buildResearchDossier (parallel: valuation, fundamentals, news, insider, latest verdict)
      → returns ResearchDossier (data_quality flags, verdict-or-note)
  LLM streams the multi-lens memo from the dossier; valuation card renders inline
  footer: "no fresh agents run / want deep web? say so"

NL: "deep dive on Tencent management, founder 王兴"
  → LLM auto-selects investment_research(preset:'management', person:'王兴', symbol:'700')
  (same engine, web bio section included)
```

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `research/dossier.ts` | aggregate Fast-profile inputs → `ResearchDossier` | yahoo, valuation fetch, contextual-news, runs-query, search |
| `research/thesis.ts` | `buildThesisSummary` (read-only) | agentRuns/Decisions/Reflections, research-intelligence |
| `research/dyp.ts` | `gatherDypContext` | recall.extractTickerCandidates, yahoo, valuation, news |
| `research/commands.ts` | registry + `parseSlashCommand` | — |
| `tools.ts` | `investment_research`, `news_pulse`, `thesis_tracker`, `dyp_ask` | the above |
| `chat-context.ts` | memo/dyp templates + slash list | — |
| `chat.post.ts` | slash parse → `toolChoice` force + arg injection | commands.ts |
| `api/chat/commands.get.ts` | serve `SLASH_COMMANDS` to the palette | commands.ts |
| chat-input palette component | `/` autocomplete, arg hints | commands endpoint |

## Error handling

- Unresolved symbol → `resolveSymbol` 422; tool returns the picker verdict, memo
  not generated on a fabricated company.
- A failed dossier source → that `DossierSection.ok=false` with a note; memo
  proceeds and states the gap; `dataQuality.missing` records it.
- No recent agents run → `agentsVerdict` note; memo offers to run one.
- Management web search failure → note + continue.
- Unknown slash command → `parseSlashCommand` returns null; treated as normal NL.
- Thesis-tracker with no runs → `latest:null`, `staleness:'none'`; tool says so.
- All tool self-fetches forward the session cookie or internal calls 401.

## Testing (TDD)

- **`parseSlashCommand`** (pure): `/investment-research 腾讯` → symbol arg;
  `/management-deep-dive 王兴 美团` → person+symbol; `/dyp-ask <free text>` →
  question=rest-of-line; preset commands set `preset`; unknown/non-slash → null.
- **`buildResearchDossier`** (mock the libs): composes all sections; a failing
  source degrades to `ok:false` + note (not a thrown error); `dataQuality.missing`
  populated; `agentsVerdict` note when no run; `management` preset adds
  `managementWeb`.
- **`buildThesisSummary`** (mock db): latest + history + confidenceTrend (up/down/
  flat/n-a) + staleness (>21d) + realizedAlpha; empty-runs → nulls.
- **`gatherDypContext`**: extracts ticker from question; bundles context; no-ticker
  path returns empty bundle without error.
- **Tools** (fetch-mock, chat-agents-debate pattern): each returns its structured
  shape; cookie forwarded; error mapping.
- **Slash dispatch**: a slash message produces a forced `toolChoice` for the right
  tool with parsed args; an NL message does not force.
- **Commands endpoint** returns the registry.

## Open questions

None outstanding. (`deep-company-series` ships v1 as a long one-shot memo with an
optional `part` continuation hint; stateful multi-part deferred — noted under
Design.)
