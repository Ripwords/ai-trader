# Research Command Suite — Engine 1 (memo) + Engine 6 (retrievers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app research command suite to the web chat — a single-company deep-research memo engine (4 presets) plus three lightweight retrievers — each invokable by natural language AND by a deterministic slash-command.

**Architecture:** Each command is a Vercel AI SDK chat tool (so NL auto-triggers it). The four memo commands share one `investment_research` tool with a `preset` arg, backed by a `buildResearchDossier` aggregator that reuses existing data libs (valuation, Yahoo fundamentals, contextual news, agents verdict). A server-side slash parser forces the right tool via `toolChoice` and injects parsed args; an optional client palette gives `/` autocomplete. The LLM composes memo/answer prose from each tool's structured payload, following templates in the system prompt.

**Tech Stack:** Nuxt 4 (Vue 3 `<script setup>`, `@ai-sdk/vue` `Chat`), Nitro/h3 server routes, Vercel AI SDK v6 (`ai@^6`), Drizzle ORM + Postgres, Zod v3, Vitest.

## Global Constraints

- **TypeScript:** never use `any`; `as unknown as X` only when strictly necessary. (CLAUDE.md)
- **TDD:** failing test first, then implement; tests assert real behavior. (CLAUDE.md)
- **Conventional Commits.** (CLAUDE.md)
- **No re-defining API return types in the frontend** — reuse server types. (CLAUDE.md)
- **Tool self-fetches MUST forward the session cookie** via `getCookie(options.event, 'session')` or internal `/api/*` calls 401. (project memory)
- **Symbol safety:** resolve names/tickers via `resolveSymbol` before using them; on non-resolved, surface the picker verdict, never fabricate a company. (canonical-resolution spec)
- **Owner scoping:** all DB reads scoped to `getOwnerId()`.
- **Tool-catalogue test:** `apps/web/tests/unit/tools.test.ts` asserts the EXACT set of tool names. Every task that adds a tool MUST add its name (sorted) to that assertion in the same task, or the suite breaks.
- **Tests:** `apps/web/tests/unit/<name>.test.ts`; run `cd apps/web && npx vitest run <file>`; full suite `npx vitest run`; typecheck `cd apps/web && npx nuxi typecheck` (works; ~2 min — be patient).
- **AI SDK v6** `streamText` accepts `toolChoice: 'auto' | 'required' | 'none' | { type: 'tool', toolName: string }`.

## Reused signatures (verified in repo)

- `resolveSymbol(input): Promise<SymbolResolution>` — `server/lib/yahoo.ts` (resolved → `{status:'resolved', symbol, name, ...}`).
- `getFinancialMetrics(symbol)`, `getHistorical(symbol, limit=5)`, `getQuarterlyHistory(symbol, limit=8)`, `getEarningsInfo(symbol)`, `getInsiderTrades(symbol, limit=20)` — `server/lib/yahoo.ts`.
- `getContextualNews({ symbol, companyName?, maxResults? }): Promise<ContextualNews>` — `server/lib/contextual-news.ts`.
- `getLatestRunForSymbol(userId, symbol): Promise<LatestRunSummary|null>`, `getRunAssessment(userId, runId): Promise<RunAssessment|null>` — `server/lib/agents/runs-query.ts`.
- `extractTickerCandidates(text, max=5): string[]` — `server/llm/recall.ts`.
- `getOwnerId(): Promise<string>` — `server/db/repo.ts`.
- Valuation: `GET /api/research/valuation?symbol=<sym>` (self-fetch with cookie).
- Tables: `agentRuns`, `agentDecisions`, `agentReflections` — `db/schema.ts`.
- `tool({ description, inputSchema, execute })` pattern + `getCookie(options.event,'session')` — `server/llm/tools.ts`; `makeTools(client, arg?)` where `arg` may be `{ event, latestUserText }`.

---

## File Structure

**Create:**
- `apps/web/server/llm/research/commands.ts` — slash registry + `parseSlashCommand`.
- `apps/web/server/llm/research/dossier.ts` — `buildResearchDossier` + `ResearchDossier`.
- `apps/web/server/llm/research/thesis.ts` — `buildThesisSummary` + `ThesisSummary`.
- `apps/web/server/llm/research/dyp.ts` — `gatherDypContext`.
- `apps/web/server/api/chat/commands.get.ts` — serve the registry to the palette.
- Test files (one per task).

**Modify:**
- `apps/web/server/llm/tools.ts` — add `investment_research`, `news_pulse`, `thesis_tracker`, `dyp_ask`.
- `apps/web/server/llm/chat-context.ts` — memo/dyp templates + slash list.
- `apps/web/server/api/chat.post.ts` — slash parse → `toolChoice` + arg directive.
- `apps/web/app/pages/index.vue` — `/` autocomplete palette over the chat input.
- `apps/web/tests/unit/tools.test.ts` — catalogue assertion (across tool-adding tasks).

---

## Task 1: Command registry + `parseSlashCommand` + commands endpoint

**Files:**
- Create: `apps/web/server/llm/research/commands.ts`
- Create: `apps/web/server/api/chat/commands.get.ts`
- Test: `apps/web/tests/unit/slash-commands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SlashArg { name: string; kind: 'symbol' | 'person' | 'text'; required: boolean }
  export interface SlashCommand { name: string; tool: string; description: string; args: SlashArg[]; preset?: string }
  export const SLASH_COMMANDS: SlashCommand[]
  export interface ParsedSlash { command: SlashCommand; args: Record<string, string> }
  export function parseSlashCommand(text: string): ParsedSlash | null
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/slash-commands.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseSlashCommand, SLASH_COMMANDS } from '../../server/llm/research/commands'

describe('SLASH_COMMANDS', () => {
  it('registers all seven commands mapped to their tools', () => {
    const names = SLASH_COMMANDS.map(c => c.name).sort()
    expect(names).toEqual([
      'deep-company-series', 'dyp-ask', 'investment-research', 'investment-team',
      'management-deep-dive', 'news-pulse', 'thesis-tracker',
    ])
    const research = SLASH_COMMANDS.find(c => c.name === 'investment-research')!
    expect(research.tool).toBe('investment_research')
    expect(research.preset).toBe('research')
  })
})

describe('parseSlashCommand', () => {
  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello world')).toBeNull()
    expect(parseSlashCommand('  not a command')).toBeNull()
  })
  it('returns null for an unknown command', () => {
    expect(parseSlashCommand('/nope AAPL')).toBeNull()
  })
  it('parses a single symbol arg', () => {
    const p = parseSlashCommand('/investment-research 腾讯')!
    expect(p.command.tool).toBe('investment_research')
    expect(p.command.preset).toBe('research')
    expect(p.args.symbol).toBe('腾讯')
  })
  it('maps preset commands to the same tool with their preset', () => {
    expect(parseSlashCommand('/investment-team 美团')!.command.preset).toBe('team')
    expect(parseSlashCommand('/deep-company-series 拼多多')!.command.preset).toBe('series')
  })
  it('parses person + symbol for management-deep-dive', () => {
    const p = parseSlashCommand('/management-deep-dive 王兴 美团')!
    expect(p.command.preset).toBe('management')
    expect(p.args.person).toBe('王兴')
    expect(p.args.symbol).toBe('美团')
  })
  it('captures the whole rest-of-line as the question for dyp-ask', () => {
    const p = parseSlashCommand('/dyp-ask 拼多多的护城河到底在哪里？')!
    expect(p.command.tool).toBe('dyp_ask')
    expect(p.args.question).toBe('拼多多的护城河到底在哪里？')
  })
  it('handles news-pulse and thesis-tracker', () => {
    expect(parseSlashCommand('/news-pulse 腾讯')!.command.tool).toBe('news_pulse')
    expect(parseSlashCommand('/thesis-tracker 拼多多')!.command.tool).toBe('thesis_tracker')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/slash-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `commands.ts`**

Create `apps/web/server/llm/research/commands.ts`:

```ts
export interface SlashArg { name: string; kind: 'symbol' | 'person' | 'text'; required: boolean }
export interface SlashCommand { name: string; tool: string; description: string; args: SlashArg[]; preset?: string }

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'investment-research', tool: 'investment_research', preset: 'research',
    description: 'Deep research memo on a company (business, financials, valuation, bull/bear, risks, verdict).',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'investment-team', tool: 'investment_research', preset: 'team',
    description: 'Research memo with explicit bull / bear / quant / macro lenses.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'deep-company-series', tool: 'investment_research', preset: 'series',
    description: 'Long-form deep-dive memo (optionally continued in parts).',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'management-deep-dive', tool: 'investment_research', preset: 'management',
    description: 'Management / founder + capital-allocation deep dive (includes a web bio search).',
    args: [{ name: 'person', kind: 'person', required: true }, { name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'news-pulse', tool: 'news_pulse',
    description: 'Grouped news digest (ticker + macro + sector/peer) for a symbol.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'thesis-tracker', tool: 'thesis_tracker',
    description: 'Read-only research history: latest verdict, confidence trend, staleness, realized alpha.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'dyp-ask', tool: 'dyp_ask',
    description: 'First-principles reasoning answer to a pointed investment question.',
    args: [{ name: 'question', kind: 'text', required: true }] },
]

const BY_NAME = new Map(SLASH_COMMANDS.map(c => [c.name, c]))

export interface ParsedSlash { command: SlashCommand; args: Record<string, string> }

/**
 * Parse a leading-slash command line. The grammar is positional and tiny:
 *   - a single `text` arg consumes the entire rest of the line (e.g. dyp-ask).
 *   - otherwise each whitespace-separated token fills the next declared arg,
 *     in order; the LAST declared arg soaks up any remaining tokens (so a
 *     multi-word company name still lands in `symbol`).
 * Returns null for non-slash input or an unknown command.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const firstSpace = trimmed.search(/\s/)
  const name = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase()
  const command = BY_NAME.get(name)
  if (!command) return null
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  const args: Record<string, string> = {}
  if (command.args.length === 1 && command.args[0]!.kind === 'text') {
    args[command.args[0]!.name] = rest
    return { command, args }
  }
  const tokens = rest.length ? rest.split(/\s+/) : []
  command.args.forEach((arg, i) => {
    if (i === command.args.length - 1) {
      args[arg.name] = tokens.slice(i).join(' ')   // last arg soaks up the remainder
    } else {
      args[arg.name] = tokens[i] ?? ''
    }
  })
  return { command, args }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/slash-commands.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Create the commands endpoint**

Create `apps/web/server/api/chat/commands.get.ts`:

```ts
import { defineEventHandler } from 'h3'
import { SLASH_COMMANDS } from '../../llm/research/commands'

// Static registry for the client slash-command palette. No auth-sensitive data.
export default defineEventHandler(() => ({ commands: SLASH_COMMANDS }))
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/web && npx nuxi typecheck`
Expected: exit 0.

```bash
git add apps/web/server/llm/research/commands.ts apps/web/server/api/chat/commands.get.ts apps/web/tests/unit/slash-commands.test.ts
git commit -m "feat(research): slash-command registry + parser + commands endpoint"
```

---

## Task 2: Research dossier engine + `investment_research` tool

**Files:**
- Create: `apps/web/server/llm/research/dossier.ts`
- Modify: `apps/web/server/llm/tools.ts`
- Modify: `apps/web/tests/unit/tools.test.ts`
- Test: `apps/web/tests/unit/research-dossier.test.ts`

**Interfaces:**
- Consumes: yahoo libs, `getContextualNews`, `resolveSymbol`, `getLatestRunForSymbol`/`getRunAssessment`, `searchWithFallback` (`server/lib/search.ts`), valuation self-fetch.
- Produces:
  ```ts
  export type ResearchPreset = 'research' | 'team' | 'series' | 'management'
  export interface DossierSection<T> { ok: boolean; note?: string; data: T | null }
  export interface ResearchDossier {
    symbol: string; companyName: string; preset: ResearchPreset; part?: number
    valuation: DossierSection<unknown>
    fundamentals: DossierSection<{ metrics: unknown; annual: unknown; quarterly: unknown; earnings: unknown }>
    insider: DossierSection<unknown>
    news: DossierSection<unknown>
    agentsVerdict: DossierSection<{ runId: string; rating: string | null; confidence: number | null; rationale: string | null; finishedAt: string | null }>
    managementWeb?: DossierSection<unknown>
    dataQuality: { full: boolean; missing: string[] }
  }
  export interface BuildDossierOpts { preset: ResearchPreset; person?: string; part?: number; userId: string; baseUrl: string; sessionCookie?: string }
  export type DossierResolutionError = { error: 'unresolved'; resolution: unknown }
  export function buildResearchDossier(symbolInput: string, opts: BuildDossierOpts): Promise<ResearchDossier | DossierResolutionError>
  ```

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/research-dossier.test.ts`. Mock the libs so the test is hermetic:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: vi.fn(async (s: string) =>
    s === 'BAD' ? { status: 'not_found' } : { status: 'resolved', symbol: 'US.NVDA', name: 'NVIDIA' }),
  getFinancialMetrics: vi.fn(async () => ({ pe: 30 })),
  getHistorical: vi.fn(async () => [{ year: 2025, revenue: 1 }]),
  getQuarterlyHistory: vi.fn(async () => [{ q: '2025Q4', eps: 1 }]),
  getEarningsInfo: vi.fn(async () => ({ nextEarningsDate: '2026-08-01' })),
  getInsiderTrades: vi.fn(async () => [{ name: 'CEO', shares: 100 }]),
}))
vi.mock('../../server/lib/contextual-news', () => ({
  getContextualNews: vi.fn(async () => ({ ticker: [], macro: [], contextual: [] })),
}))
vi.mock('../../server/lib/agents/runs-query', () => ({
  getLatestRunForSymbol: vi.fn(async () => ({ runId: 'r1', rating: 'BUY', confidence: 72, finishedAt: '2026-06-27T00:00:00Z' })),
  getRunAssessment: vi.fn(async () => ({ runId: 'r1', rating: 'BUY', confidence: 72, rationale: 'strong', finishedAt: '2026-06-27T00:00:00Z' })),
}))
vi.mock('../../server/lib/search', () => ({ searchWithFallback: vi.fn(async () => ({ results: [{ title: 'bio' }] })) }))

let buildResearchDossier: typeof import('../../server/llm/research/dossier')['buildResearchDossier']
beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
    ({ ok: true, json: async () => ({ fair_value: 100, data_quality: 'full' }) }) as unknown as Response) as unknown as typeof fetch
  buildResearchDossier = (await import('../../server/llm/research/dossier')).buildResearchDossier
})

const baseOpts = { preset: 'research' as const, userId: 'u1', baseUrl: 'http://x', sessionCookie: 'session=abc' }

describe('buildResearchDossier', () => {
  it('returns an unresolved error for a bad symbol (no fabrication)', async () => {
    const d = await buildResearchDossier('BAD', baseOpts)
    expect(d).toMatchObject({ error: 'unresolved' })
  })
  it('aggregates all fast-profile sections and the latest agents verdict', async () => {
    const d = await buildResearchDossier('NVDA', baseOpts) as Awaited<ReturnType<typeof buildResearchDossier>> & { symbol: string }
    expect(d).toMatchObject({ symbol: 'US.NVDA', companyName: 'NVIDIA', preset: 'research' })
    const dossier = d as Extract<typeof d, { valuation: unknown }>
    expect(dossier.valuation.ok).toBe(true)
    expect(dossier.fundamentals.ok).toBe(true)
    expect(dossier.news.ok).toBe(true)
    expect(dossier.agentsVerdict.ok).toBe(true)
    expect(dossier.agentsVerdict.data?.rating).toBe('BUY')
    expect(dossier.dataQuality.missing).toEqual([])
  })
  it('degrades a failing source to ok:false with a note instead of throwing', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    ;(yahoo.getFinancialMetrics as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'))
    const d = await buildResearchDossier('NVDA', baseOpts) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { fundamentals: unknown }>
    expect(d.fundamentals.ok).toBe(false)
    expect(d.dataQuality.missing).toContain('fundamentals')
  })
  it('notes when there is no recent agents run', async () => {
    const rq = await import('../../server/lib/agents/runs-query')
    ;(rq.getLatestRunForSymbol as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const d = await buildResearchDossier('NVDA', baseOpts) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { agentsVerdict: unknown }>
    expect(d.agentsVerdict.ok).toBe(false)
    expect(d.agentsVerdict.note).toMatch(/run the agents/i)
  })
  it('adds a managementWeb section for the management preset', async () => {
    const d = await buildResearchDossier('NVDA', { ...baseOpts, preset: 'management', person: 'Jensen Huang' }) as Extract<Awaited<ReturnType<typeof buildResearchDossier>>, { managementWeb?: unknown }>
    expect(d.managementWeb?.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/research-dossier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dossier.ts`**

Create `apps/web/server/llm/research/dossier.ts`:

```ts
import {
  resolveSymbol, getFinancialMetrics, getHistorical, getQuarterlyHistory,
  getEarningsInfo, getInsiderTrades,
} from '../../lib/yahoo'
import { getContextualNews } from '../../lib/contextual-news'
import { getLatestRunForSymbol, getRunAssessment } from '../../lib/agents/runs-query'
import { searchWithFallback } from '../../lib/search'

export type ResearchPreset = 'research' | 'team' | 'series' | 'management'
export interface DossierSection<T> { ok: boolean; note?: string; data: T | null }
export interface ResearchDossier {
  symbol: string; companyName: string; preset: ResearchPreset; part?: number
  valuation: DossierSection<unknown>
  fundamentals: DossierSection<{ metrics: unknown; annual: unknown; quarterly: unknown; earnings: unknown }>
  insider: DossierSection<unknown>
  news: DossierSection<unknown>
  agentsVerdict: DossierSection<{ runId: string; rating: string | null; confidence: number | null; rationale: string | null; finishedAt: string | null }>
  managementWeb?: DossierSection<unknown>
  dataQuality: { full: boolean; missing: string[] }
}
export interface BuildDossierOpts {
  preset: ResearchPreset; person?: string; part?: number
  userId: string; baseUrl: string; sessionCookie?: string
}
export type DossierResolutionError = { error: 'unresolved'; resolution: unknown }

function ok<T>(data: T): DossierSection<T> { return { ok: true, data } }
function fail<T>(note: string): DossierSection<T> { return { ok: false, note, data: null } }

async function section<T>(label: string, fn: () => Promise<T>): Promise<DossierSection<T>> {
  try { return ok(await fn()) } catch (e) { return fail<T>(`${label} unavailable: ${(e as Error)?.message ?? 'error'}`) }
}

export async function buildResearchDossier(
  symbolInput: string, opts: BuildDossierOpts,
): Promise<ResearchDossier | DossierResolutionError> {
  const resolution = await resolveSymbol(symbolInput)
  if (resolution.status !== 'resolved') return { error: 'unresolved', resolution }
  const symbol = resolution.symbol
  const companyName = resolution.name

  const [valuation, fundamentals, insider, news, agentsVerdict, managementWeb] = await Promise.all([
    section('valuation', async () => {
      const res = await fetch(`${opts.baseUrl}/api/research/valuation?symbol=${encodeURIComponent(symbol)}`, {
        headers: { ...(opts.sessionCookie ? { cookie: opts.sessionCookie } : {}) },
      })
      if (!res.ok) throw new Error(`valuation ${res.status}`)
      return res.json()
    }),
    section('fundamentals', async () => ({
      metrics: await getFinancialMetrics(symbol),
      annual: await getHistorical(symbol),
      quarterly: await getQuarterlyHistory(symbol),
      earnings: await getEarningsInfo(symbol),
    })),
    section('insider', () => getInsiderTrades(symbol)),
    section('news', () => getContextualNews({ symbol, companyName, maxResults: 10 })),
    (async (): Promise<DossierSection<ResearchDossier['agentsVerdict']['data']>> => {
      try {
        const latest = await getLatestRunForSymbol(opts.userId, symbol)
        if (!latest) return fail('no recent agents run — say "run the agents" to add a fresh verdict')
        const a = await getRunAssessment(opts.userId, latest.runId)
        if (!a) return fail('no recent agents run — say "run the agents" to add a fresh verdict')
        return ok({ runId: a.runId, rating: a.rating, confidence: a.confidence, rationale: a.rationale, finishedAt: a.finishedAt })
      } catch (e) { return fail(`agents verdict unavailable: ${(e as Error)?.message ?? 'error'}`) }
    })(),
    opts.preset === 'management'
      ? section('management web', () => searchWithFallback(
          `${opts.person ?? companyName} ${companyName} CEO founder track record capital allocation`, 'general'))
      : Promise.resolve(undefined),
  ])

  const sections: Record<string, DossierSection<unknown>> = { valuation, fundamentals, insider, news, agentsVerdict }
  const missing = Object.entries(sections).filter(([, s]) => !s.ok).map(([k]) => k)

  const dossier: ResearchDossier = {
    symbol, companyName, preset: opts.preset, part: opts.part,
    valuation, fundamentals, insider, news, agentsVerdict,
    dataQuality: { full: missing.length === 0, missing },
  }
  if (managementWeb) dossier.managementWeb = managementWeb
  return dossier
}
```

> Note: confirm `searchWithFallback`'s exact signature in `server/lib/search.ts` (the second arg is the topic; the existing `search_web` tool shows the call shape). Adapt the call if it differs — the dossier only needs "a web search that returns results or throws."

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/research-dossier.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add the `investment_research` tool**

In `apps/web/server/llm/tools.ts`, add before `'agents_debate'`:

```ts
    'investment_research': tool({
      description:
        'Produce a deep-research MEMO on a company by aggregating valuation, fundamentals, contextual news, insider activity, and the latest agents verdict. preset controls emphasis: research=standard 7-section memo; team=bull/bear/quant/macro lenses; series=long-form (optional part); management=founder/capital-allocation focus + web bio (pass person). Fast — reuses existing data, does NOT start a fresh agents run. Use for "deep dive / research report / full analysis on X".',
      inputSchema: z.object({
        symbol: z.string().describe('Ticker or company name, e.g. NVDA, US.NVDA, 腾讯'),
        preset: z.enum(['research', 'team', 'series', 'management']).default('research'),
        person: z.string().optional().describe('For preset=management: the executive/founder to focus on'),
        part: z.number().int().min(1).optional().describe('For preset=series: which part to continue'),
      }),
      execute: async ({ symbol, preset, person, part }) => {
        const { getOwnerId } = await import('../db/repo')
        const { buildResearchDossier } = await import('./research/dossier')
        const baseUrl = process.env.NUXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        const sessionCookie = options.event ? getCookie(options.event, 'session') : undefined
        const userId = await getOwnerId()
        const dossier = await buildResearchDossier(symbol, {
          preset, person, part, userId, baseUrl,
          sessionCookie: sessionCookie ? `session=${sessionCookie}` : undefined,
        })
        return dossier
      },
    }),
```

- [ ] **Step 6: Update the tool-catalogue assertion**

In `apps/web/tests/unit/tools.test.ts`, add `'investment_research',` to the sorted expected list (alphabetical position: after `'holdings_context'`, before `'market_kline'`).

- [ ] **Step 7: Run tool tests + dossier test + typecheck**

Run: `cd apps/web && npx vitest run tests/unit/tools.test.ts tests/unit/research-dossier.test.ts && npx nuxi typecheck`
Expected: all pass; typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/llm/research/dossier.ts apps/web/server/llm/tools.ts apps/web/tests/unit/research-dossier.test.ts apps/web/tests/unit/tools.test.ts
git commit -m "feat(research): dossier engine + investment_research memo tool (4 presets)"
```

---

## Task 3: `news_pulse` + `thesis_tracker` tools

**Files:**
- Create: `apps/web/server/llm/research/thesis.ts`
- Modify: `apps/web/server/llm/tools.ts`
- Modify: `apps/web/tests/unit/tools.test.ts`
- Test: `apps/web/tests/unit/thesis-summary.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ThesisRun { runId: string; rating: string | null; confidence: number | null; finishedAt: string | null }
  export interface ThesisSummary {
    symbol: string
    latest: ThesisRun | null
    history: ThesisRun[]
    confidenceTrend: 'up' | 'down' | 'flat' | 'n/a'
    staleness: 'fresh' | 'stale' | 'none'
    realizedAlpha: number | null
  }
  export function summarizeThesis(symbol: string, runs: ThesisRun[], reflectionAlpha: number | null, now: number): ThesisSummary  // pure
  export function buildThesisSummary(userId: string, symbol: string): Promise<ThesisSummary>  // db
  ```
- `staleness`: `none` if no runs; `stale` if latest finishedAt older than 21 days; else `fresh`.
- `confidenceTrend`: compare latest vs previous run confidence (`up`/`down`/`flat`); `n/a` if <2 runs with confidence.

- [ ] **Step 1: Write the failing test (pure `summarizeThesis`)**

Create `apps/web/tests/unit/thesis-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { summarizeThesis } from '../../server/llm/research/thesis'

const now = Date.parse('2026-06-28T00:00:00Z')

describe('summarizeThesis', () => {
  it('reports none/empty for a symbol with no runs', () => {
    const s = summarizeThesis('NVDA', [], null, now)
    expect(s).toMatchObject({ latest: null, history: [], confidenceTrend: 'n/a', staleness: 'none', realizedAlpha: null })
  })
  it('marks fresh and rising confidence', () => {
    const runs = [
      { runId: 'b', rating: 'BUY', confidence: 80, finishedAt: '2026-06-27T00:00:00Z' },
      { runId: 'a', rating: 'BUY', confidence: 60, finishedAt: '2026-06-20T00:00:00Z' },
    ] // newest first
    const s = summarizeThesis('NVDA', runs, 6.5, now)
    expect(s.latest?.runId).toBe('b')
    expect(s.confidenceTrend).toBe('up')
    expect(s.staleness).toBe('fresh')
    expect(s.realizedAlpha).toBe(6.5)
  })
  it('marks stale when the latest run is older than 21 days', () => {
    const runs = [{ runId: 'a', rating: 'HOLD', confidence: 50, finishedAt: '2026-05-01T00:00:00Z' }]
    expect(summarizeThesis('NVDA', runs, null, now).staleness).toBe('stale')
  })
  it('flat when confidence is unchanged, n/a when <2 have confidence', () => {
    expect(summarizeThesis('X', [{ runId: 'a', rating: 'BUY', confidence: 70, finishedAt: '2026-06-27T00:00:00Z' }], null, now).confidenceTrend).toBe('n/a')
    const flat = [
      { runId: 'b', rating: 'BUY', confidence: 70, finishedAt: '2026-06-27T00:00:00Z' },
      { runId: 'a', rating: 'BUY', confidence: 70, finishedAt: '2026-06-20T00:00:00Z' },
    ]
    expect(summarizeThesis('X', flat, null, now).confidenceTrend).toBe('flat')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/thesis-summary.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `thesis.ts`**

Create `apps/web/server/llm/research/thesis.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions, agentReflections } from '../../../db/schema'

export interface ThesisRun { runId: string; rating: string | null; confidence: number | null; finishedAt: string | null }
export interface ThesisSummary {
  symbol: string
  latest: ThesisRun | null
  history: ThesisRun[]
  confidenceTrend: 'up' | 'down' | 'flat' | 'n/a'
  staleness: 'fresh' | 'stale' | 'none'
  realizedAlpha: number | null
}

const STALE_DAYS = 21

/** Pure summary from newest-first runs. */
export function summarizeThesis(symbol: string, runs: ThesisRun[], reflectionAlpha: number | null, now: number): ThesisSummary {
  if (runs.length === 0) {
    return { symbol, latest: null, history: [], confidenceTrend: 'n/a', staleness: 'none', realizedAlpha: reflectionAlpha }
  }
  const latest = runs[0]!
  const withConf = runs.filter(r => r.confidence != null)
  let confidenceTrend: ThesisSummary['confidenceTrend'] = 'n/a'
  if (withConf.length >= 2) {
    const diff = (withConf[0]!.confidence ?? 0) - (withConf[1]!.confidence ?? 0)
    confidenceTrend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
  }
  let staleness: ThesisSummary['staleness'] = 'fresh'
  if (latest.finishedAt) {
    const ageDays = (now - Date.parse(latest.finishedAt)) / 86_400_000
    if (ageDays > STALE_DAYS) staleness = 'stale'
  }
  return { symbol, latest, history: runs, confidenceTrend, staleness, realizedAlpha: reflectionAlpha }
}

export async function buildThesisSummary(userId: string, symbol: string): Promise<ThesisSummary> {
  const db = getDb()
  const rows = await db
    .select({
      runId: agentRuns.id, status: agentRuns.status, finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating, confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.symbol, symbol)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(20)

  const runs: ThesisRun[] = rows
    .filter(r => r.status !== 'running')
    .map(r => ({ runId: r.runId, rating: r.rating, confidence: r.confidence, finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null }))

  // Realized alpha from the most recent 'overall' reflection for this symbol's latest decided run, if any.
  let alpha: number | null = null
  if (runs[0]) {
    const decRows = await db.select({ id: agentDecisions.id }).from(agentDecisions)
      .where(eq(agentDecisions.runId, runs[0].runId)).limit(1)
    const decId = decRows[0]?.id
    if (decId) {
      const refl = await db.select({ alpha: agentReflections.alpha }).from(agentReflections)
        .where(and(eq(agentReflections.decisionId, decId), eq(agentReflections.role, 'overall'))).limit(1)
      const raw = refl[0]?.alpha
      alpha = raw != null ? Number(raw) : null
    }
  }
  return summarizeThesis(symbol, runs, alpha, Date.now())
}
```

> Note: confirm `agentReflections` has `alpha` and `role` columns (per schema.ts they do). If `alpha` is `numeric` it comes back as a string — `Number(raw)` handles it.

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/thesis-summary.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the two tools**

In `apps/web/server/llm/tools.ts`, before `'agents_debate'`:

```ts
    'news_pulse': tool({
      description:
        'A grouped news digest for a symbol: ticker-specific + macro + sector/peer context. Use for "what\'s the news on X", "news pulse", "latest on X". Summarize the result; do not dump every headline.',
      inputSchema: z.object({ symbol: z.string(), companyName: z.string().optional() }),
      execute: async ({ symbol, companyName }) => {
        const { getContextualNews } = await import('../lib/contextual-news')
        return getContextualNews({ symbol, companyName, maxResults: 12 })
      },
    }),

    'thesis_tracker': tool({
      description:
        "Read-only research history for a symbol: latest agents verdict, run history, confidence trend, staleness (stale after 21 days), and realized alpha. Use for \"how's my thesis on X\", \"thesis tracker\", \"has my research on X aged\". Does not start a run.",
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        const { getOwnerId } = await import('../db/repo')
        const { resolveSymbol } = await import('../lib/yahoo')
        const { buildThesisSummary } = await import('./research/thesis')
        const resolution = await resolveSymbol(symbol)
        const sym = resolution.status === 'resolved' ? resolution.symbol : symbol
        const userId = await getOwnerId()
        return buildThesisSummary(userId, sym)
      },
    }),
```

- [ ] **Step 6: Update the tool-catalogue assertion**

In `apps/web/tests/unit/tools.test.ts`, add `'news_pulse',` (after `'market_snapshot'`/before `'portfolio_mpt_analysis'` — sorted) and `'thesis_tracker',` (after `'ticker_news_context'`/before `'trade_account_overview'` — sorted). Verify final array stays alphabetically sorted.

- [ ] **Step 7: Run + typecheck**

Run: `cd apps/web && npx vitest run tests/unit/tools.test.ts tests/unit/thesis-summary.test.ts && npx nuxi typecheck`
Expected: pass; exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/llm/research/thesis.ts apps/web/server/llm/tools.ts apps/web/tests/unit/thesis-summary.test.ts apps/web/tests/unit/tools.test.ts
git commit -m "feat(research): news_pulse + thesis_tracker tools"
```

---

## Task 4: `dyp_ask` tool + context gatherer

**Files:**
- Create: `apps/web/server/llm/research/dyp.ts`
- Modify: `apps/web/server/llm/tools.ts`
- Modify: `apps/web/tests/unit/tools.test.ts`
- Test: `apps/web/tests/unit/dyp-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DypContext { question: string; symbol: string | null; companyName: string | null; fundamentals: unknown | null; valuation: unknown | null; news: unknown | null }
  export function gatherDypContext(opts: { question: string; symbol?: string; baseUrl: string; sessionCookie?: string }): Promise<DypContext>
  ```
- Extracts a ticker from `question` (via `extractTickerCandidates`) if `symbol` not passed; if a symbol resolves, attaches a light bundle (metrics + valuation + news); if none, returns nulls (LLM answers from reasoning).

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/dyp-context.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: vi.fn(async (s: string) => s.includes('NVDA') ? { status: 'resolved', symbol: 'US.NVDA', name: 'NVIDIA' } : { status: 'not_found' }),
  getFinancialMetrics: vi.fn(async () => ({ pe: 30 })),
}))
vi.mock('../../server/lib/contextual-news', () => ({ getContextualNews: vi.fn(async () => ({ ticker: [] })) }))

let gatherDypContext: typeof import('../../server/llm/research/dyp')['gatherDypContext']
beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
    ({ ok: true, json: async () => ({ fair_value: 100 }) }) as unknown as Response) as unknown as typeof fetch
  gatherDypContext = (await import('../../server/llm/research/dyp')).gatherDypContext
})

describe('gatherDypContext', () => {
  it('extracts a ticker from the question and attaches a context bundle', async () => {
    const c = await gatherDypContext({ question: 'where is NVDA moat?', baseUrl: 'http://x' })
    expect(c.symbol).toBe('US.NVDA')
    expect(c.companyName).toBe('NVIDIA')
    expect(c.fundamentals).not.toBeNull()
    expect(c.valuation).not.toBeNull()
  })
  it('returns nulls when no ticker is present (pure-reasoning path)', async () => {
    const c = await gatherDypContext({ question: 'is moat investing dead?', baseUrl: 'http://x' })
    expect(c.symbol).toBeNull()
    expect(c.fundamentals).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/dyp-context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dyp.ts`**

Create `apps/web/server/llm/research/dyp.ts`:

```ts
import { resolveSymbol, getFinancialMetrics } from '../../lib/yahoo'
import { getContextualNews } from '../../lib/contextual-news'
import { extractTickerCandidates } from '../recall'

export interface DypContext {
  question: string
  symbol: string | null
  companyName: string | null
  fundamentals: unknown | null
  valuation: unknown | null
  news: unknown | null
}

export async function gatherDypContext(
  opts: { question: string; symbol?: string; baseUrl: string; sessionCookie?: string },
): Promise<DypContext> {
  const base: DypContext = { question: opts.question, symbol: null, companyName: null, fundamentals: null, valuation: null, news: null }

  const candidate = opts.symbol ?? extractTickerCandidates(opts.question, 1)[0]
  if (!candidate) return base
  const resolution = await resolveSymbol(candidate)
  if (resolution.status !== 'resolved') return base

  const symbol = resolution.symbol
  base.symbol = symbol
  base.companyName = resolution.name

  // Light, best-effort bundle — never throw out of the gatherer.
  base.fundamentals = await getFinancialMetrics(symbol).catch(() => null)
  base.valuation = await fetch(`${opts.baseUrl}/api/research/valuation?symbol=${encodeURIComponent(symbol)}`, {
    headers: { ...(opts.sessionCookie ? { cookie: opts.sessionCookie } : {}) },
  }).then(r => r.ok ? r.json() : null).catch(() => null)
  base.news = await getContextualNews({ symbol, companyName: resolution.name, maxResults: 6 }).catch(() => null)
  return base
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/dyp-context.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the `dyp_ask` tool**

In `apps/web/server/llm/tools.ts`, before `'agents_debate'`:

```ts
    'dyp_ask': tool({
      description:
        'Answer a pointed investment question with first-principles reasoning, grounded in the app\'s data when a ticker is referenced. Use for sharp analytical questions like "where is PDD\'s moat really?" or "is this priced in?". Returns the question plus a light context bundle; compose a structured reasoned answer.',
      inputSchema: z.object({
        question: z.string().describe('The investment question to reason about'),
        symbol: z.string().optional().describe('Optional explicit ticker if the question is about one'),
      }),
      execute: async ({ question, symbol }) => {
        const { gatherDypContext } = await import('./research/dyp')
        const baseUrl = process.env.NUXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        const sessionCookie = options.event ? getCookie(options.event, 'session') : undefined
        return gatherDypContext({ question, symbol, baseUrl, sessionCookie: sessionCookie ? `session=${sessionCookie}` : undefined })
      },
    }),
```

- [ ] **Step 6: Update the tool-catalogue assertion**

In `apps/web/tests/unit/tools.test.ts`, add `'dyp_ask',` (sorted: after `'convert_fx'`/before `'holdings_context'`).

- [ ] **Step 7: Run + typecheck**

Run: `cd apps/web && npx vitest run tests/unit/tools.test.ts tests/unit/dyp-context.test.ts && npx nuxi typecheck`
Expected: pass; exit 0.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/llm/research/dyp.ts apps/web/server/llm/tools.ts apps/web/tests/unit/dyp-context.test.ts apps/web/tests/unit/tools.test.ts
git commit -m "feat(research): dyp_ask first-principles reasoning tool"
```

---

## Task 5: System-prompt templates (memo presets + dyp + slash list)

**Files:**
- Modify: `apps/web/server/llm/chat-context.ts`
- Test: `apps/web/tests/unit/chat-context-research.test.ts`

**Interfaces:**
- `buildSystemPrompt(ghostfolioStatus, recallContext?)` signature is UNCHANGED — this task only adds static instruction lines to the returned prompt.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/chat-context-research.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'

describe('buildSystemPrompt — research suite guidance', () => {
  const p = buildSystemPrompt('not_configured')
  it('documents the investment_research memo sections and presets', () => {
    expect(p).toMatch(/investment_research/)
    expect(p).toMatch(/Bull.*Bear/i)
    expect(p).toMatch(/preset/i)
  })
  it('documents the dyp_ask reasoning structure', () => {
    expect(p).toMatch(/dyp_ask/)
    expect(p).toMatch(/first.principles/i)
    expect(p).toMatch(/what would change/i)
  })
  it('lists the slash commands', () => {
    expect(p).toMatch(/\/investment-research/)
    expect(p).toMatch(/\/thesis-tracker/)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/chat-context-research.test.ts`
Expected: FAIL — strings absent.

- [ ] **Step 3: Add the guidance block**

In `apps/web/server/llm/chat-context.ts`, inside the array returned by `buildSystemPrompt`, add the following entries just before the final `MOOMOO_RULES` entry (and before the recall conditional spread if present — order doesn't matter as long as it's in the array):

```ts
    '',
    'RESEARCH SUITE (investment_research / news_pulse / thesis_tracker / dyp_ask):',
    '- investment_research returns a structured DOSSIER (valuation, fundamentals, insider, news, latest agents verdict, dataQuality). Write a MEMO from it — do not dump the raw JSON. Sections: 1) Business & moat 2) Financials (revenue/margins/FCF trend) 3) Valuation (DCF fair value, scenarios, margin of safety) 4) Bull case / Bear case 5) Risks 6) Management 7) Verdict. Render the valuation card inline; do not restate its numbers as prose. If dataQuality.missing is non-empty, state the gaps honestly. If agentsVerdict is absent, cite no verdict and offer: "no fresh agents run — say \'run the agents\' and I\'ll start one; say \'deep web\' for web research."',
    '- preset shapes the memo: research=all 7 sections balanced; team=foreground four lenses (bull, bear, quantitative, macro) as distinct voices; series=long-form, and if part>1 continue from where the prior part ended; management=lead with founder/management track record, capital allocation, incentive alignment (use the managementWeb section).',
    '- news_pulse: summarize the three news groups (ticker / macro / sector-peer) into a short pulse; link the why, do not list every headline.',
    '- thesis_tracker: report the latest verdict, confidence trend, staleness, and realized alpha plainly; it is read-only history, not a new analysis.',
    '- dyp_ask: answer with FIRST-PRINCIPLES reasoning in this shape: (a) decompose the question, (b) marshal evidence from the provided context bundle (and say when evidence is thin), (c) steelman the strongest case, (d) the strongest counter, (e) a clear conclusion, (f) "what would change my mind." Ground claims in the bundle; flag speculation.',
    '- Slash commands the user may type (treat them as direct requests): /investment-research <ticker>, /investment-team <ticker>, /deep-company-series <ticker>, /management-deep-dive <person> <ticker>, /news-pulse <ticker>, /thesis-tracker <ticker>, /dyp-ask <question>.',
```

- [ ] **Step 4: Run to confirm pass + ensure prior chat-context test still green**

Run: `cd apps/web && npx vitest run tests/unit/chat-context-research.test.ts`
Expected: PASS (3 tests). Then confirm the existing prompt test still passes: `npx vitest run tests/unit/tools.test.ts` is unrelated; run any existing chat-context test if present (search `buildSystemPrompt`): `npx vitest run` and confirm no regressions.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx nuxi typecheck`
Expected: exit 0.

```bash
git add apps/web/server/llm/chat-context.ts apps/web/tests/unit/chat-context-research.test.ts
git commit -m "feat(chat): system-prompt templates for research memo + dyp_ask + slash list"
```

---

## Task 6: Server-side slash dispatch (`toolChoice` + arg directive)

**Files:**
- Modify: `apps/web/server/api/chat.post.ts`
- Test: `apps/web/tests/unit/chat-slash-dispatch.test.ts`

**Approach:** Extract a pure helper that, given the latest user text, returns the streamText overrides for a slash command — the forced `toolChoice` and a directive string appended to the system prompt instructing the exact tool + args. Unit-test the helper; wire it into `chat.post.ts`.

**Interfaces:**
- Produces (in a new small module `apps/web/server/llm/research/dispatch.ts`):
  ```ts
  export interface SlashDispatch { toolName: string; directive: string }
  export function slashDispatch(latestUserText: string): SlashDispatch | null
  ```
  `directive` example: `The user invoked the /investment-team command. Call the investment_research tool now with symbol="美团", preset="team". Then write the memo from its result.`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/chat-slash-dispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { slashDispatch } from '../../server/llm/research/dispatch'

describe('slashDispatch', () => {
  it('returns null for natural language', () => {
    expect(slashDispatch('what is NVDA worth?')).toBeNull()
  })
  it('forces investment_research with preset + symbol for a memo command', () => {
    const d = slashDispatch('/investment-team 美团')!
    expect(d.toolName).toBe('investment_research')
    expect(d.directive).toContain('investment_research')
    expect(d.directive).toContain('美团')
    expect(d.directive).toContain('team')
  })
  it('forces management-deep-dive with person + symbol', () => {
    const d = slashDispatch('/management-deep-dive 王兴 美团')!
    expect(d.toolName).toBe('investment_research')
    expect(d.directive).toContain('王兴')
    expect(d.directive).toContain('美团')
    expect(d.directive).toContain('management')
  })
  it('forces dyp_ask with the question', () => {
    const d = slashDispatch('/dyp-ask 拼多多的护城河到底在哪里？')!
    expect(d.toolName).toBe('dyp_ask')
    expect(d.directive).toContain('拼多多的护城河到底在哪里')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/chat-slash-dispatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `dispatch.ts`**

Create `apps/web/server/llm/research/dispatch.ts`:

```ts
import { parseSlashCommand } from './commands'

export interface SlashDispatch { toolName: string; directive: string }

/**
 * Map a slash-command message to a deterministic tool dispatch: the tool to
 * force via streamText toolChoice, plus a directive appended to the system
 * prompt that pins the exact arguments. Returns null for natural-language input.
 */
export function slashDispatch(latestUserText: string): SlashDispatch | null {
  const parsed = parseSlashCommand(latestUserText)
  if (!parsed) return null
  const { command, args } = parsed
  const argPairs = Object.entries(args)
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => `${k}="${v}"`)
  const presetPart = command.preset ? `${argPairs.length ? ', ' : ''}preset="${command.preset}"` : ''
  const directive =
    `The user invoked the /${command.name} command. Call the ${command.tool} tool now with ` +
    `${argPairs.join(', ')}${presetPart}. Then write the response from its result following the research-suite guidance.`
  return { toolName: command.tool, directive }
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/chat-slash-dispatch.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `chat.post.ts`**

In `apps/web/server/api/chat.post.ts`, after `recallContext` is computed and before `streamText`, add:

```ts
  const { slashDispatch } = await import('../llm/research/dispatch')
  const dispatch = slashDispatch(newestUserText)
  const systemPrompt = dispatch
    ? `${buildSystemPrompt(ghostfolioStatus, recallContext)}\n\n${dispatch.directive}`
    : buildSystemPrompt(ghostfolioStatus, recallContext)
```

Then change the `streamText` call:

```ts
  const result = streamText({
    model: buildModel(),
    system: systemPrompt,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(8),
    ...(dispatch ? { toolChoice: { type: 'tool', toolName: dispatch.toolName } } : {}),
  })
```

> The forced `toolChoice` makes the model call exactly that tool first; the directive pins the args. `stopWhen: stepCountIs(8)` still lets it stream the memo prose after the tool result. Verify against `ai@^6` that `toolChoice: { type: 'tool', toolName }` is accepted (it is in v6); if the type name differs, adapt to the installed version's `ToolChoice` shape — do not cast to `any`.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd apps/web && npx nuxi typecheck && npx vitest run`
Expected: typecheck exit 0; full suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/server/llm/research/dispatch.ts apps/web/server/api/chat.post.ts apps/web/tests/unit/chat-slash-dispatch.test.ts
git commit -m "feat(chat): deterministic server-side slash-command dispatch via toolChoice"
```

---

## Task 7: Client slash-command palette (autocomplete)

**Files:**
- Modify: `apps/web/app/pages/index.vue`
- Test: `apps/web/tests/unit/slash-palette.test.ts`

**Approach:** A small pure filter for autocomplete suggestions (TDD), then minimal UI wiring: when the input starts with `/`, fetch the registry once and show a filtered dropdown; selecting an item inserts `"/name "` into the input. Submission is unchanged (the raw text flows to the server, which dispatches). Keep the UI minimal and consistent with the existing `UChatPrompt`.

**Interfaces:**
- Produces (a tiny exported helper, co-located or in `app/lib/slash.ts`):
  ```ts
  export interface PaletteItem { name: string; description: string }
  export function filterСommandPalette(input: string, commands: PaletteItem[]): PaletteItem[]
  ```
  (ASCII name: `filterCommandPalette`.) Returns `[]` when input doesn't start with `/`; otherwise case-insensitive prefix match on the token after `/`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/slash-palette.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { filterCommandPalette } from '../../app/lib/slash'

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
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/slash-palette.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/lib/slash.ts`**

Create `apps/web/app/lib/slash.ts`:

```ts
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
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/slash-palette.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the palette into `index.vue`**

In `apps/web/app/pages/index.vue` `<script setup>`:
- Add reactive state and a one-time registry fetch:

```ts
import { filterCommandPalette, type PaletteItem } from '../lib/slash'

const slashCommands = ref<PaletteItem[]>([])
const slashSuggestions = computed(() => filterCommandPalette(input.value, slashCommands.value))
async function ensureCommands() {
  if (slashCommands.value.length) return
  try {
    const r = await $fetch<{ commands: PaletteItem[] }>('/api/chat/commands')
    slashCommands.value = r.commands ?? []
  } catch { /* palette is optional */ }
}
function applySlash(name: string) { input.value = `/${name} `; }
watch(input, (v) => { if (v.startsWith('/')) void ensureCommands() })
```

- In the template, render a dropdown above the `UChatPrompt` when `slashSuggestions.length`:

```vue
        <div v-if="slashSuggestions.length" class="slash-palette">
          <button
            v-for="s in slashSuggestions"
            :key="s.name"
            type="button"
            class="slash-item"
            @click="applySlash(s.name)"
          >
            <span class="slash-name">/{{ s.name }}</span>
            <span class="slash-desc">{{ s.description }}</span>
          </button>
        </div>
```

Add minimal scoped styles consistent with the existing chat styling (a bordered list, hover highlight). Do not change `onSubmit` — the raw `/command ...` text submits as today and the server dispatches.

- [ ] **Step 6: Typecheck + full suite**

Run: `cd apps/web && npx nuxi typecheck && npx vitest run`
Expected: typecheck exit 0; full suite green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/lib/slash.ts apps/web/app/pages/index.vue apps/web/tests/unit/slash-palette.test.ts
git commit -m "feat(chat): slash-command autocomplete palette in chat input"
```

---

## Task 8: End-to-end verification in the running app

**Files:** none (verification only).

- [ ] **Step 1: Rebuild**

Run: `docker compose up -d --build web api`
Expected: both healthy.

- [ ] **Step 2: Slash memo**

In chat, type `/investment-research 腾讯`. Expected: palette shows on `/`; after send, a sectioned memo streams (Business/Financials/Valuation/Bull-Bear/Risks/Management/Verdict), valuation card renders inline, and if no recent agents run it offers to start one. Confirm it resolved 腾讯 to the right listing (Tencent / 0700.HK), not a wrong company.

- [ ] **Step 3: Preset divergence**

`/investment-team 美团` → four explicit lenses. `/management-deep-dive 王兴 美团` → management-led memo referencing 王兴 (web bio). Confirm both hit `investment_research` with the right preset (check it's one tool).

- [ ] **Step 4: Natural-language path**

Send `do a deep research report on Apple`. Expected: the model auto-calls `investment_research` (no slash needed).

- [ ] **Step 5: Retrievers**

`/news-pulse 腾讯` → grouped news pulse. `/thesis-tracker 拼多多` → verdict/trend/staleness/alpha (or "no runs yet"). `/dyp-ask 拼多多的护城河到底在哪里？` → first-principles answer with the (a)–(f) structure.

- [ ] **Step 6: Unknown command**

Send `/bogus AAPL`. Expected: treated as normal NL (no crash; `parseSlashCommand` → null, no forced tool).

- [ ] **Step 7: Commit (if verification-driven fixes were needed)**

```bash
git add -A && git commit -m "fix(research): address e2e verification findings"
```

---

## Self-Review

**Spec coverage:**
- Slash invocation + NL invocation (spec Layer A/B) → Tasks 1 (registry/parse), 6 (server dispatch), 7 (client palette); tools are NL-invokable (Tasks 2–4). ✓
- Memo engine + 4 presets, Fast profile, agents-verdict-as-input, management web (spec Engine 1) → Task 2 (`buildResearchDossier`, `investment_research`), Task 5 (templates). ✓
- `news_pulse`, `thesis_tracker` (read-only), `dyp_ask` first-principles (spec Engine 6) → Tasks 3, 4, 5. ✓
- Deterministic dispatch via `toolChoice` + arg directive (spec Layer B) → Task 6. ✓
- System-prompt templates per preset + dyp structure + slash list (spec Layer C) → Task 5. ✓
- Commands endpoint for palette (spec) → Task 1. ✓
- Error handling: unresolved symbol (dossier returns `{error:'unresolved'}`; thesis/dyp fall back), failing source → `ok:false`+note, no agents run note, web fail note, unknown slash → null (spec Error handling) → Tasks 2,3,4,6 + tests. ✓
- Owner scoping (spec) → `getOwnerId()` in thesis/dossier/dyp tools. ✓
- Testing matrix (spec) → pure TDD targets: `parseSlashCommand`, `buildResearchDossier`, `summarizeThesis`, `gatherDypContext`, `slashDispatch`, `filterCommandPalette`, prompt-content assertions. ✓

**Placeholder scan:** No TBD/TODO; every step has concrete code or exact strings. Two "confirm signature" notes (`searchWithFallback`, `agentReflections.alpha`) point at real existing symbols to verify, not unwritten code. ✓

**Type consistency:** `ResearchPreset`, `ResearchDossier`/`DossierSection`, `ThesisSummary`/`ThesisRun`, `DypContext`, `SlashCommand`/`ParsedSlash`, `SlashDispatch`, `PaletteItem` each defined once and referenced consistently. The four tools (`investment_research`, `news_pulse`, `thesis_tracker`, `dyp_ask`) are named identically in tools.ts, the registry, dispatch, and the catalogue test. `buildSystemPrompt` signature is unchanged (Task 5 adds only static lines). ✓

**Tool-catalogue maintenance:** Tasks 2/3/4 each update `tools.test.ts` in-task (the lesson from the prior slice), preventing a broken suite. ✓

**Scope:** One coherent slice (Engine 1 + Engine 6); Engines 2–5 explicitly excluded. ✓
