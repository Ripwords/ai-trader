# Chat-Triggered Async Research, Done-Notification, and Run Recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let chat start a research run asynchronously, fire a native browser notification when any run (chat- or UI-started) finishes, and make chat automatically aware of recent runs for any ticker the user mentions.

**Architecture:** A shared `startAgentRun` helper backs both the existing inline streaming endpoint and a new fire-and-forget endpoint that drains the run into the DB in a detached promise. A global client-side tracker polls a new `active-runs` endpoint and fires notifications on completion. Chat gains three tools (`research_start`, `research_status`, `research_get`) plus an auto-hint that injects recent-run summaries into the system prompt for mentioned tickers.

**Tech Stack:** Nuxt 4 (Vue 3, `<script setup>`), Nitro server routes (h3), Drizzle ORM + Postgres, Vercel AI SDK (`tool()`), Vitest. Backend research pipeline is FastAPI/LangGraph (unchanged by this plan).

## Global Constraints

- **TypeScript:** never use `any`; use `as unknown as X` only when strictly necessary. (from CLAUDE.md)
- **TDD:** write the failing test first, then implement. (from CLAUDE.md)
- **Conventional Commits** for every commit. (from CLAUDE.md)
- **Data fetching:** never `fetch` + `useEffect`/lifecycle for *page data*; this plan's polling tracker is an explicitly-approved background poller (not page data) and mirrors the existing `useAgentsRun` poll loop. Do not introduce TanStack Query for it. (from CLAUDE.md + spec)
- **Notification mechanism:** native `Notification` Web API only — no service workers / Web Push / VAPID. (from spec non-goals)
- **No new MCP server.** The trigger is a chat tool. (from spec non-goals)
- **Symbol safety:** never start a run on a raw unresolved symbol — go through `resolveSymbol`. (from `agents-run.post.ts` and the canonical-resolution spec)
- **Owner scoping:** all DB reads/writes are scoped to `getOwnerId()`; runs belonging to another user must 404, not leak.
- **Run after edits:** rebuild web/api containers when verifying in-app (`docker compose up -d --build web`). Unit tests run locally: `cd apps/web && npx vitest run`, typecheck `npx nuxi typecheck`.
- **Tests live in** `apps/web/tests/unit/*.test.ts`; node env by default, add `// @vitest-environment happy-dom` docblock for DOM/Notification tests.

---

## File Structure

**Create:**
- `apps/web/server/utils/ndjson.ts` — pure NDJSON line splitter (shared parse logic).
- `apps/web/server/lib/agents/start-run.ts` — `startAgentRun()` (resolve + gate + insert + upstream fetch) and `drainIntoTee()` (detached server-side stream consumer).
- `apps/web/server/api/research/agents-run-async.post.ts` — fire-and-forget run starter.
- `apps/web/server/api/research/active-runs.get.ts` — owner's in-flight + recently-finished runs.
- `apps/web/server/lib/agents/runs-query.ts` — `shapeActiveRuns()` (pure), `getActiveRuns()`, `getLatestRunForSymbol()`, `getRunAssessment()` repo helpers.
- `apps/web/server/llm/recall.ts` — `extractTickerCandidates()` (pure), `formatRecallLine()` (pure), `buildRecallContext()`.
- `apps/web/composables/useActiveRuns.ts` — `computeNotifications()` (pure) + the polling composable.
- `apps/web/app/lib/notify.ts` — `requestRunNotificationPermission()`, `fireRunNotification()` (Notification API wrappers).
- `apps/web/app/components/ActiveRunsWatcher.vue` — headless component that runs the tracker; mounted once in the layout.
- Test files (one per task, see tasks).

**Modify:**
- `apps/web/server/api/research/agents-run.post.ts` — refactor to use `startAgentRun()` + `splitNdjson()` (no behavior change).
- `apps/web/server/llm/tools.ts` — add `research_start`, `research_status`, `research_get` tools.
- `apps/web/server/api/chat.post.ts` — inject recall context into the system prompt.
- `apps/web/server/llm/chat-context.ts` — accept optional recall text; add a one-line tool-usage note.
- `apps/web/app/layouts/default.vue` — mount `<ActiveRunsWatcher />`.

---

## Task 1: Shared NDJSON splitter + extract `startAgentRun`

Refactor the inline endpoint so its pre-stream logic (resolve, concurrency gate, row insert, upstream fetch) and its NDJSON parsing are reusable. **No behavior change** — existing tests must still pass.

**Files:**
- Create: `apps/web/server/utils/ndjson.ts`
- Create: `apps/web/server/lib/agents/start-run.ts`
- Modify: `apps/web/server/api/research/agents-run.post.ts`
- Test: `apps/web/tests/unit/ndjson-split.test.ts`

**Interfaces:**
- Consumes: `resolveSymbol` (`server/lib/yahoo.ts`), `getOwnerId` (`server/db/repo.ts`), `agentRuns` (`db/schema.ts`), `AgentRunTee` (`server/utils/agents-tee.ts`), `AgentEvent` (`types/agents.ts`).
- Produces:
  - `splitNdjson(buf: string, chunk: string): { events: AgentEvent[]; rest: string }`
  - `interface AgentsRunBody { symbol: string; max_debate_rounds?: number; max_risk_discuss_rounds?: number; deep_thinking?: boolean; reasoning_effort?: 'low'|'medium'|'high'|'xhigh'|'max'; response_language?: 'en-US'|'zh-TW'|'zh-CN'|'ja-JP'|'ko-KR'|'de-DE'; selected_analysts?: string[]; trade_date?: string }`
  - `interface StartedRun { run: typeof agentRuns.$inferSelect; userId: string; upstream: Response }`
  - `startAgentRun(body: AgentsRunBody): Promise<StartedRun>` — throws `createError` for missing symbol (400), unresolved symbol (422 with `data: resolution`), in-flight duplicate (409 with `data: { run_id }`), upstream failure (502, after marking the row failed).

- [ ] **Step 1: Write the failing test for `splitNdjson`**

Create `apps/web/tests/unit/ndjson-split.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { splitNdjson } from '../../server/utils/ndjson'

describe('splitNdjson', () => {
  it('parses complete lines and buffers a partial trailing line', () => {
    const a = splitNdjson('', '{"type":"node-start","node":"market"}\n{"type":"node-st')
    expect(a.events).toEqual([{ type: 'node-start', node: 'market' }])
    expect(a.rest).toBe('{"type":"node-st')

    const b = splitNdjson(a.rest, 'art","node":"trader"}\n')
    expect(b.events).toEqual([{ type: 'node-start', node: 'trader' }])
    expect(b.rest).toBe('')
  })

  it('skips blank and malformed lines', () => {
    const r = splitNdjson('', '\n\nnot-json\n{"type":"run-end","run_id":"r","tokens_in":0,"tokens_out":0,"cost_usd":0}\n')
    expect(r.events).toHaveLength(1)
    expect((r.events[0] as { type: string }).type).toBe('run-end')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd apps/web && npx vitest run tests/unit/ndjson-split.test.ts`
Expected: FAIL — cannot find module `server/utils/ndjson`.

- [ ] **Step 3: Implement `splitNdjson`**

Create `apps/web/server/utils/ndjson.ts`:

```ts
import type { AgentEvent } from '../../types/agents'

/**
 * Stateless NDJSON line splitter. Pass the leftover ``rest`` from the previous
 * call as ``buf`` to stitch across chunk boundaries. Malformed / blank lines
 * are skipped silently (the upstream stream is best-effort).
 */
export function splitNdjson(buf: string, chunk: string): { events: AgentEvent[]; rest: string } {
  const combined = buf + chunk
  const lines = combined.split('\n')
  const rest = lines.pop() ?? ''
  const events: AgentEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as AgentEvent)
    } catch {
      /* skip malformed */
    }
  }
  return { events, rest }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `cd apps/web && npx vitest run tests/unit/ndjson-split.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Extract `startAgentRun`**

Create `apps/web/server/lib/agents/start-run.ts`. Move the resolve/gate/insert/upstream-fetch logic out of `agents-run.post.ts` verbatim (lines 10-146 of the current file), changing only: it takes a plain `body` (no `event`), reads `getOwnerId()` itself, and returns `{ run, userId, upstream }` instead of building a stream.

```ts
import { and, eq, gte, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { resolveSymbol } from '../../lib/yahoo'

export interface AgentsRunBody {
  symbol: string
  max_debate_rounds?: number
  max_risk_discuss_rounds?: number
  deep_thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language?: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts?: string[]
  trade_date?: string
}

export interface StartedRun {
  run: typeof agentRuns.$inferSelect
  userId: string
  upstream: Response
}

const STALE_RUN_CUTOFF_MIN = 15

/**
 * Resolve + concurrency-gate + insert the agent_runs row + open the upstream
 * FastAPI NDJSON stream. Shared by the inline streaming endpoint
 * (agents-run.post.ts) and the fire-and-forget endpoint
 * (agents-run-async.post.ts). Throws createError on every failure path so both
 * callers get identical status codes (400/409/422/502).
 */
export async function startAgentRun(body: AgentsRunBody): Promise<StartedRun> {
  const userId = await getOwnerId()
  if (!body?.symbol) throw createError({ statusCode: 400, statusMessage: 'symbol required' })

  const resolution = await resolveSymbol(body.symbol)
  if (resolution.status !== 'resolved') {
    throw createError({
      statusCode: 422,
      statusMessage: 'symbol could not be uniquely resolved — pick from search',
      data: resolution,
    })
  }
  const symbol = resolution.symbol
  const companyName = resolution.name
  const tradeDate = body.trade_date ?? new Date().toISOString().slice(0, 10)
  const db = getDb()

  const cutoff = new Date(Date.now() - STALE_RUN_CUTOFF_MIN * 60_000)
  const inflight = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.userId, userId),
      eq(agentRuns.symbol, symbol),
      eq(agentRuns.status, 'running'),
      gte(agentRuns.startedAt, cutoff),
    ))
    .limit(1)
  if (inflight[0]) {
    throw createError({
      statusCode: 409,
      statusMessage: 'a run is already in progress for this symbol',
      data: { run_id: inflight[0].id },
    })
  }
  await db
    .update(agentRuns)
    .set({ status: 'failed', error: 'stale (no run-end before cutoff)', finishedAt: new Date() })
    .where(and(
      eq(agentRuns.userId, userId),
      eq(agentRuns.symbol, symbol),
      eq(agentRuns.status, 'running'),
      sql`${agentRuns.startedAt} < ${cutoff}`,
    ))

  const inserted = await db
    .insert(agentRuns)
    .values({
      userId,
      symbol,
      tradeDate,
      status: 'running',
      config: {
        company_name: companyName,
        max_debate_rounds: body.max_debate_rounds ?? 1,
        max_risk_discuss_rounds: body.max_risk_discuss_rounds ?? 1,
        deep_thinking: body.deep_thinking ?? true,
        reasoning_effort: body.reasoning_effort ?? 'medium',
        response_language: body.response_language ?? 'en-US',
        selected_analysts: body.selected_analysts ?? ['market', 'social', 'news', 'fundamentals'],
      },
    })
    .returning()
  const run = inserted[0]!

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const upstream = await fetch(`${apiBase}/agents/run`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalBearer}`,
      'content-type': 'application/json',
      'x-user-id': userId,
    },
    body: JSON.stringify({
      symbol,
      company_name: companyName,
      trade_date: tradeDate,
      max_debate_rounds: body.max_debate_rounds ?? 1,
      max_risk_discuss_rounds: body.max_risk_discuss_rounds ?? 1,
      deep_thinking: body.deep_thinking ?? true,
      reasoning_effort: body.reasoning_effort ?? 'medium',
      response_language: body.response_language ?? 'en-US',
      selected_analysts: body.selected_analysts ?? ['market', 'social', 'news', 'fundamentals'],
      run_id: run.id,
    }),
  })

  if (!upstream.ok || !upstream.body) {
    await db.update(agentRuns).set({ status: 'failed', error: `upstream ${upstream.status}` }).where(eq(agentRuns.id, run.id))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  return { run, userId, upstream }
}
```

- [ ] **Step 6: Refactor `agents-run.post.ts` to use the helper + splitter**

Replace the body of `apps/web/server/api/research/agents-run.post.ts` with:

```ts
import { defineEventHandler, readBody } from 'h3'
import { AgentRunTee } from '../../utils/agents-tee'
import { splitNdjson } from '../../utils/ndjson'
import { startAgentRun, type AgentsRunBody } from '../../lib/agents/start-run'

export default defineEventHandler(async (event) => {
  const body = await readBody<AgentsRunBody>(event)
  const { run, userId, upstream } = await startAgentRun(body)

  const tee = new AgentRunTee(run.id, userId)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let teeBuf = ''
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        const tail = splitNdjson(teeBuf, '\n')
        for (const ev of tail.events) tee.push(ev)
        controller.close()
        return
      }
      controller.enqueue(value)
      const { events, rest } = splitNdjson(teeBuf, decoder.decode(value, { stream: true }))
      teeBuf = rest
      for (const ev of events) tee.push(ev)
    },
    cancel() {
      void reader.cancel()
    },
  })

  event.node.res.setHeader('content-type', 'application/x-ndjson')
  event.node.res.setHeader('cache-control', 'no-store')
  return stream
})
```

- [ ] **Step 7: Verify existing tests still pass (no behavior change)**

Run: `cd apps/web && npx vitest run tests/unit/research-agents-run-resolve.test.ts tests/unit/ndjson-split.test.ts`
Expected: PASS. Then `npx nuxi typecheck` — expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/utils/ndjson.ts apps/web/server/lib/agents/start-run.ts apps/web/server/api/research/agents-run.post.ts apps/web/tests/unit/ndjson-split.test.ts
git commit -m "refactor(research): extract startAgentRun + splitNdjson from inline run endpoint"
```

---

## Task 2: Async run endpoint + `research_start` / `research_status` tools

**Files:**
- Create: `apps/web/server/api/research/agents-run-async.post.ts`
- Modify: `apps/web/server/lib/agents/start-run.ts` (add `drainIntoTee`)
- Modify: `apps/web/server/llm/tools.ts`
- Test: `apps/web/tests/unit/chat-research-start.test.ts`

**Interfaces:**
- Consumes: `startAgentRun`, `splitNdjson`, `AgentRunTee`.
- Produces:
  - `drainIntoTee(upstream: Response, runId: string, userId: string): Promise<void>` — reads the full NDJSON stream into a new `AgentRunTee`. Never throws to the caller (logs internally); the tee marks the row failed on `error`/`run-end` as today.
  - `POST /api/research/agents-run-async` → `{ runId: string; status: 'running'; symbol: string }`.
  - Tools `research_start({ symbol, max_debate_rounds?, deep_thinking? })` and `research_status({ runId })`.

- [ ] **Step 1: Write the failing test for the tools**

Create `apps/web/tests/unit/chat-research-start.test.ts` (mirrors `chat-agents-debate.test.ts`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import type { H3Event } from 'h3'

type ToolMap = Record<string, {
  description?: string
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
}>

let makeTools: (client: ApiClient, arg?: unknown) => ToolMap
beforeEach(async () => {
  vi.resetModules()
  makeTools = (await import('../../server/llm/tools')).makeTools as unknown as typeof makeTools
})

function fakeEventWithCookie(cookie: string): H3Event {
  return { node: { req: { headers: { cookie } } } } as unknown as H3Event
}
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('research_start tool', () => {
  it('is defined with a schema', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools.research_start).toBeDefined()
    expect(typeof tools.research_start.description).toBe('string')
  })

  it('posts to agents-run-async and returns the run id + a notify hint', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { runId: 'run-9', status: 'running', symbol: 'NVDA' }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc'))
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>

    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toContain('/api/research/agents-run-async')
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect((init.headers as Record<string, string>).cookie).toBe('session=abc')
    expect(out).toMatchObject({ runId: 'run-9', status: 'running', symbol: 'NVDA' })
    expect(String(out.message)).toMatch(/notif/i)
  })

  it('surfaces a 409 duplicate as a friendly already-running result', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(409, { data: { run_id: 'existing-1' } })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>
    expect(out).toMatchObject({ status: 'already_running', runId: 'existing-1' })
  })
})

describe('research_status tool', () => {
  it('returns the run status from agent-messages', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(200, { runId: 'run-9', status: 'complete', lastSeq: 12 })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_status.execute({ runId: 'run-9' }, {} as unknown) as Record<string, unknown>
    expect(out).toMatchObject({ runId: 'run-9', status: 'complete' })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/chat-research-start.test.ts`
Expected: FAIL — `tools.research_start` is undefined.

- [ ] **Step 3: Add `drainIntoTee` to `start-run.ts`**

Append to `apps/web/server/lib/agents/start-run.ts`:

```ts
import { AgentRunTee } from '../../utils/agents-tee'
import { splitNdjson } from '../../utils/ndjson'

/**
 * Consume the upstream NDJSON stream entirely into a fresh AgentRunTee. Used by
 * the fire-and-forget endpoint: it is started with ``void`` so it outlives the
 * HTTP response. Safe because the app runs under a long-lived Node process
 * (Docker, not serverless); the server-side reader keeps the stream alive so
 * the api's client-disconnect kill does not trigger. The tee finalizes the
 * agent_runs row (complete/failed) exactly as the inline path does.
 */
export async function drainIntoTee(upstream: Response, runId: string, userId: string): Promise<void> {
  const tee = new AgentRunTee(runId, userId)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const { events, rest } = splitNdjson(buf, decoder.decode(value, { stream: true }))
      buf = rest
      for (const ev of events) tee.push(ev)
    }
    const tail = splitNdjson(buf, '\n')
    for (const ev of tail.events) tee.push(ev)
  } catch (e: unknown) {
    console.error('[agents-async] drain failed', (e as Error)?.message)
  }
}
```

- [ ] **Step 4: Create the async endpoint**

Create `apps/web/server/api/research/agents-run-async.post.ts`:

```ts
import { defineEventHandler, readBody } from 'h3'
import { startAgentRun, drainIntoTee, type AgentsRunBody } from '../../lib/agents/start-run'

/**
 * Fire-and-forget research run. Creates the agent_runs row and opens the
 * upstream stream synchronously (so resolution/concurrency errors surface to
 * the caller), then drains the stream into the DB in a DETACHED promise and
 * returns the run id immediately. The browser is notified of completion by the
 * global ActiveRunsWatcher polling /api/research/active-runs.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<AgentsRunBody>(event)
  const { run, userId, upstream } = await startAgentRun(body)
  // Detached: survives the response under the long-lived Node server.
  void drainIntoTee(upstream, run.id, userId)
  return { runId: run.id, status: 'running' as const, symbol: run.symbol }
})
```

- [ ] **Step 5: Add the two tools**

In `apps/web/server/llm/tools.ts`, inside `makeTools()`'s returned object (place them just before `'agents_debate'` at line 430), add:

```ts
    'research_start': tool({
      description:
        'Start a research run (the multi-agent analyst → debate → trader → risk pipeline) on a symbol ASYNCHRONOUSLY. Returns immediately with a runId; the run finishes in the background (~30-90s) and the user gets a browser notification. Use this when the user asks to "research X", "kick off analysis on X", or wants to keep chatting while it runs. Use agents_debate instead only when the user explicitly wants to watch the debate stream inline now.',
      inputSchema: z.object({
        symbol: z.string().describe('Ticker symbol, e.g. AAPL or US.NVDA'),
        max_debate_rounds: z.number().int().min(1).max(3).default(1),
        deep_thinking: z.boolean().default(true),
      }),
      execute: async (args) => {
        const baseUrl = process.env.NUXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        const sessionCookie = options.event ? getCookie(options.event, 'session') : undefined
        const res = await fetch(`${baseUrl}/api/research/agents-run-async`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(sessionCookie ? { cookie: `session=${sessionCookie}` } : {}),
          },
          body: JSON.stringify(args),
        })
        if (res.status === 409) {
          const body = await res.json().catch(() => ({})) as { data?: { run_id?: string } }
          return { status: 'already_running', runId: body?.data?.run_id ?? null, symbol: args.symbol }
        }
        if (!res.ok) {
          return { status: 'error', error: `research start failed: ${res.status}`, symbol: args.symbol }
        }
        const body = await res.json() as { runId: string; status: string; symbol: string }
        return {
          ...body,
          message: `Research started for ${body.symbol}. You'll get a browser notification when it's done; I can pull the assessment with research_get once it completes.`,
        }
      },
    }),

    'research_status': tool({
      description:
        'Check the current status of a research run by its runId (running / complete / failed). Use after research_start if the user asks "is it done yet".',
      inputSchema: z.object({ runId: z.string() }),
      execute: async ({ runId }) => {
        const baseUrl = process.env.NUXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        const sessionCookie = options.event ? getCookie(options.event, 'session') : undefined
        const res = await fetch(`${baseUrl}/api/research/agent-messages?run_id=${encodeURIComponent(runId)}&since=999999`, {
          headers: { ...(sessionCookie ? { cookie: `session=${sessionCookie}` } : {}) },
        })
        if (!res.ok) return { runId, status: 'unknown', error: `status check failed: ${res.status}` }
        const body = await res.json() as { runId: string; status: string }
        return { runId: body.runId, status: body.status }
      },
    }),
```

> Note: `research_status` passes `since=999999` so it gets the run row's status without re-downloading the event log.

- [ ] **Step 6: Run the test to confirm it passes**

Run: `cd apps/web && npx vitest run tests/unit/chat-research-start.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `cd apps/web && npx nuxi typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/api/research/agents-run-async.post.ts apps/web/server/lib/agents/start-run.ts apps/web/server/llm/tools.ts apps/web/tests/unit/chat-research-start.test.ts
git commit -m "feat(research): async run endpoint + research_start/research_status chat tools"
```

---

## Task 3: `active-runs` endpoint + query helpers

**Files:**
- Create: `apps/web/server/lib/agents/runs-query.ts`
- Create: `apps/web/server/api/research/active-runs.get.ts`
- Test: `apps/web/tests/unit/active-runs-shape.test.ts`

**Interfaces:**
- Consumes: `agentRuns`, `agentDecisions`, `getOwnerId`, `getDb`.
- Produces:
  - Types:
    ```ts
    export interface ActiveRun { runId: string; symbol: string; startedAt: string | null }
    export interface FinishedRun { runId: string; symbol: string; status: 'complete' | 'failed' | 'cancelled'; rating: string | null; confidence: number | null }
    export interface ActiveRunsResponse { active: ActiveRun[]; recentlyFinished: FinishedRun[] }
    ```
  - `shapeActiveRuns(activeRows, finishedRows): ActiveRunsResponse` (pure).
  - `getActiveRuns(userId: string, finishedSinceMs: number): Promise<ActiveRunsResponse>`.
  - `GET /api/research/active-runs` → `ActiveRunsResponse` for the owner; `recentlyFinished` = runs whose `finishedAt` is within the last 3 minutes.

- [ ] **Step 1: Write the failing test for `shapeActiveRuns`**

Create `apps/web/tests/unit/active-runs-shape.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shapeActiveRuns } from '../../server/lib/agents/runs-query'

describe('shapeActiveRuns', () => {
  it('maps running rows and joins decisions onto finished rows', () => {
    const out = shapeActiveRuns(
      [{ id: 'a', symbol: 'NVDA', startedAt: new Date('2026-06-28T10:00:00Z') }],
      [{ id: 'b', symbol: 'TSLA', status: 'complete', rating: 'BUY', confidence: 72 },
       { id: 'c', symbol: 'MU', status: 'failed', rating: null, confidence: null }],
    )
    expect(out.active).toEqual([{ runId: 'a', symbol: 'NVDA', startedAt: '2026-06-28T10:00:00.000Z' }])
    expect(out.recentlyFinished).toEqual([
      { runId: 'b', symbol: 'TSLA', status: 'complete', rating: 'BUY', confidence: 72 },
      { runId: 'c', symbol: 'MU', status: 'failed', rating: null, confidence: null },
    ])
  })

  it('handles empty inputs', () => {
    expect(shapeActiveRuns([], [])).toEqual({ active: [], recentlyFinished: [] })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/active-runs-shape.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `runs-query.ts`**

Create `apps/web/server/lib/agents/runs-query.ts`:

```ts
import { and, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions } from '../../../db/schema'

export interface ActiveRun { runId: string; symbol: string; startedAt: string | null }
export interface FinishedRun {
  runId: string
  symbol: string
  status: 'complete' | 'failed' | 'cancelled'
  rating: string | null
  confidence: number | null
}
export interface ActiveRunsResponse { active: ActiveRun[]; recentlyFinished: FinishedRun[] }

interface ActiveRow { id: string; symbol: string; startedAt: Date | null }
interface FinishedRow { id: string; symbol: string; status: string; rating: string | null; confidence: number | null }

/** Pure shaper — DB rows → API response. */
export function shapeActiveRuns(activeRows: ActiveRow[], finishedRows: FinishedRow[]): ActiveRunsResponse {
  return {
    active: activeRows.map(r => ({
      runId: r.id,
      symbol: r.symbol,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    })),
    recentlyFinished: finishedRows.map(r => ({
      runId: r.id,
      symbol: r.symbol,
      status: r.status as FinishedRun['status'],
      rating: r.rating,
      confidence: r.confidence,
    })),
  }
}

export async function getActiveRuns(userId: string, finishedSinceMs: number): Promise<ActiveRunsResponse> {
  const db = getDb()
  const activeRows = await db
    .select({ id: agentRuns.id, symbol: agentRuns.symbol, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.status, 'running')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(50)

  const cutoff = new Date(Date.now() - finishedSinceMs)
  const finishedRows = await db
    .select({
      id: agentRuns.id,
      symbol: agentRuns.symbol,
      status: agentRuns.status,
      rating: agentDecisions.rating,
      confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(
      eq(agentRuns.userId, userId),
      ne(agentRuns.status, 'running'),
      gte(agentRuns.finishedAt, cutoff),
    ))
    .orderBy(desc(agentRuns.finishedAt))
    .limit(50)

  return shapeActiveRuns(activeRows, finishedRows)
}
```

> `inArray` is imported for use in Task 4's helper added to this same file; if your linter flags it as unused now, add Task 4's helper in this task's file or remove the import until Task 4. (It is used in Task 4.)

- [ ] **Step 4: Create the endpoint**

Create `apps/web/server/api/research/active-runs.get.ts`:

```ts
import { defineEventHandler } from 'h3'
import { getOwnerId } from '../../db/repo'
import { getActiveRuns } from '../../lib/agents/runs-query'

const RECENTLY_FINISHED_MS = 3 * 60_000

export default defineEventHandler(async () => {
  const userId = await getOwnerId()
  return getActiveRuns(userId, RECENTLY_FINISHED_MS)
})
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd apps/web && npx vitest run tests/unit/active-runs-shape.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx nuxi typecheck`
Expected: no new errors. (If `inArray` is reported unused, defer its import to Task 4.)

- [ ] **Step 7: Commit**

```bash
git add apps/web/server/lib/agents/runs-query.ts apps/web/server/api/research/active-runs.get.ts apps/web/tests/unit/active-runs-shape.test.ts
git commit -m "feat(research): active-runs endpoint for in-flight + recently-finished runs"
```

---

## Task 4: `research_get` tool + `getRunAssessment` / `getLatestRunForSymbol`

**Files:**
- Modify: `apps/web/server/lib/agents/runs-query.ts`
- Modify: `apps/web/server/llm/tools.ts`
- Test: `apps/web/tests/unit/runs-assessment.test.ts`

**Interfaces:**
- Produces:
  - ```ts
    export interface RunAssessment {
      runId: string; symbol: string; status: string
      rating: string | null; confidence: number | null; rationale: string | null
      finishedAt: string | null
    }
    export interface LatestRunSummary {
      runId: string; symbol: string; status: string; finishedAt: string | null
      rating: string | null; confidence: number | null
    }
    ```
  - `summarizeRunRow(row): LatestRunSummary` (pure).
  - `getLatestRunForSymbol(userId, symbol): Promise<LatestRunSummary | null>` — latest non-running run for the symbol.
  - `getRunAssessment(userId, runId): Promise<RunAssessment | null>` — owner-scoped; null if not found/not owned.
  - Tool `research_get({ runId?, symbol? })` — resolves by runId, else latest completed run for symbol.

- [ ] **Step 1: Write the failing test for `summarizeRunRow`**

Create `apps/web/tests/unit/runs-assessment.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { summarizeRunRow } from '../../server/lib/agents/runs-query'

describe('summarizeRunRow', () => {
  it('maps a joined run+decision row into a summary', () => {
    const out = summarizeRunRow({
      id: 'r1', symbol: 'NVDA', status: 'complete',
      finishedAt: new Date('2026-06-28T12:00:00Z'),
      rating: 'BUY', confidence: 72,
    })
    expect(out).toEqual({
      runId: 'r1', symbol: 'NVDA', status: 'complete',
      finishedAt: '2026-06-28T12:00:00.000Z', rating: 'BUY', confidence: 72,
    })
  })

  it('tolerates a run with no decision', () => {
    const out = summarizeRunRow({
      id: 'r2', symbol: 'MU', status: 'failed', finishedAt: null, rating: null, confidence: null,
    })
    expect(out).toEqual({
      runId: 'r2', symbol: 'MU', status: 'failed', finishedAt: null, rating: null, confidence: null,
    })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/runs-assessment.test.ts`
Expected: FAIL — `summarizeRunRow` not exported.

- [ ] **Step 3: Add helpers to `runs-query.ts`**

Append to `apps/web/server/lib/agents/runs-query.ts`:

```ts
export interface LatestRunSummary {
  runId: string; symbol: string; status: string; finishedAt: string | null
  rating: string | null; confidence: number | null
}
export interface RunAssessment extends LatestRunSummary { rationale: string | null }

interface RunDecisionRow {
  id: string; symbol: string; status: string; finishedAt: Date | null
  rating: string | null; confidence: number | null
}

/** Pure shaper for a joined run+decision row. */
export function summarizeRunRow(row: RunDecisionRow): LatestRunSummary {
  return {
    runId: row.id,
    symbol: row.symbol,
    status: row.status,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    rating: row.rating,
    confidence: row.confidence,
  }
}

/** Latest non-running run for (user, symbol), or null. Symbol matched case-insensitively-ish by exact stored value. */
export async function getLatestRunForSymbol(userId: string, symbol: string): Promise<LatestRunSummary | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status,
      finishedAt: agentRuns.finishedAt, rating: agentDecisions.rating, confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.symbol, symbol), ne(agentRuns.status, 'running')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1)
  return rows[0] ? summarizeRunRow(rows[0]) : null
}

/** Full assessment for a runId (owner-scoped). Null if missing or not owned. */
export async function getRunAssessment(userId: string, runId: string): Promise<RunAssessment | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status, userId: agentRuns.userId,
      finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating, confidence: agentDecisions.confidence, rationale: agentDecisions.rationale,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1)
  const row = rows[0]
  if (!row || row.userId !== userId) return null
  return { ...summarizeRunRow(row), rationale: row.rationale }
}
```

> Now `inArray` from Task 3's import is unused — remove it from the import list in this file's top `import { and, desc, eq, gte, ne } from 'drizzle-orm'` if present.

- [ ] **Step 4: Add the `research_get` tool**

In `apps/web/server/llm/tools.ts`, add after `research_status` (from Task 2):

```ts
    'research_get': tool({
      description:
        "Fetch the assessment from a completed research run so you can cite the agents' actual verdict. Pass runId if you have it (e.g. from an auto-injected recent-run hint or research_start), otherwise pass symbol to get that ticker's latest completed run. Returns rating, confidence, and rationale. Use this whenever the user references a ticker that has a recent run — do NOT re-run research_start if a recent assessment already exists.",
      inputSchema: z.object({
        runId: z.string().optional(),
        symbol: z.string().optional(),
      }),
      execute: async ({ runId, symbol }) => {
        const { getOwnerId } = await import('../db/repo')
        const { getRunAssessment, getLatestRunForSymbol } = await import('../lib/agents/runs-query')
        const userId = await getOwnerId()
        if (runId) {
          const a = await getRunAssessment(userId, runId)
          return a ?? { error: 'run not found', runId }
        }
        if (symbol) {
          const latest = await getLatestRunForSymbol(userId, symbol)
          if (!latest) return { error: 'no research run found for symbol', symbol }
          const a = await getRunAssessment(userId, latest.runId)
          return a ?? { error: 'run not found', runId: latest.runId }
        }
        return { error: 'pass runId or symbol' }
      },
    }),
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd apps/web && npx vitest run tests/unit/runs-assessment.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && npx nuxi typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/server/lib/agents/runs-query.ts apps/web/server/llm/tools.ts apps/web/tests/unit/runs-assessment.test.ts
git commit -m "feat(research): research_get tool + run assessment query helpers"
```

---

## Task 5: Ticker recall — auto-inject recent-run hints into chat

**Files:**
- Create: `apps/web/server/llm/recall.ts`
- Modify: `apps/web/server/llm/chat-context.ts`
- Modify: `apps/web/server/api/chat.post.ts`
- Test: `apps/web/tests/unit/ticker-recall.test.ts`

**Interfaces:**
- Consumes: `resolveSymbol` (`server/lib/yahoo.ts`), `getLatestRunForSymbol` (`server/lib/agents/runs-query.ts`), `ApiClient.listWatchlist`.
- Produces:
  - `extractTickerCandidates(text: string, max?: number): string[]` (pure).
  - `formatRecallLine(s: LatestRunSummary, nowMs: number): string` (pure).
  - `buildRecallContext(opts: { userId: string; text: string; watchlist: string[] }): Promise<string>` — returns '' or a newline-joined block of hint lines (no header).

- [ ] **Step 1: Write the failing test (pure functions)**

Create `apps/web/tests/unit/ticker-recall.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractTickerCandidates, formatRecallLine } from '../../server/llm/recall'

describe('extractTickerCandidates', () => {
  it('finds bare uppercase tickers', () => {
    expect(extractTickerCandidates('should I trim NVDA?')).toEqual(['NVDA'])
  })
  it('finds cashtags case-insensitively and uppercases them', () => {
    expect(extractTickerCandidates('compare $nvda and $Tsla')).toEqual(['NVDA', 'TSLA'])
  })
  it('drops common stopwords and 1-letter words', () => {
    expect(extractTickerCandidates('A I OK THE AND BUY NVDA')).toEqual(['NVDA'])
  })
  it('ignores lowercase bare words (avoids false positives)', () => {
    expect(extractTickerCandidates('should i buy aapl today')).toEqual([])
  })
  it('dedupes and caps at max', () => {
    expect(extractTickerCandidates('NVDA NVDA TSLA AMD MU AAPL GOOG', 3)).toEqual(['NVDA', 'TSLA', 'AMD'])
  })
})

describe('formatRecallLine', () => {
  it('formats a completed run with age, rating and confidence', () => {
    const now = Date.parse('2026-06-28T12:00:00Z')
    const line = formatRecallLine(
      { runId: 'abcdef1234', symbol: 'NVDA', status: 'complete',
        finishedAt: '2026-06-28T10:00:00Z', rating: 'BUY', confidence: 72 },
      now,
    )
    expect(line).toContain('NVDA')
    expect(line).toContain('BUY')
    expect(line).toContain('conf 72')
    expect(line).toContain('2h ago')
    expect(line).toContain('abcdef12') // short run id for research_get
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/ticker-recall.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `recall.ts`**

Create `apps/web/server/llm/recall.ts`:

```ts
import type { LatestRunSummary } from '../lib/agents/runs-query'

// Uppercase words that look like tickers but almost never are, in a trading
// chat. Keeps the bare-word path from injecting noise.
const STOPWORDS = new Set([
  'A', 'I', 'OK', 'THE', 'AND', 'FOR', 'ARE', 'BUY', 'SELL', 'HOLD', 'ALL',
  'USD', 'HKD', 'MYR', 'EPS', 'PE', 'DCF', 'MPT', 'ETF', 'IPO', 'CEO', 'NYSE',
  'US', 'HK', 'SH', 'SZ', 'YES', 'NO', 'IT', 'IS', 'IF', 'OR', 'TO', 'OF',
])

/**
 * Extract probable ticker symbols from free text. Two sources:
 *   - cashtags ``$xyz`` (any case → uppercased) — high signal.
 *   - bare ALL-CAPS tokens 1-5 chars — medium signal, stopword-filtered.
 * Bare lowercase words are intentionally NOT matched: "buy aapl" would be too
 * noisy. Returns de-duplicated, order-preserving, capped to ``max``.
 */
export function extractTickerCandidates(text: string, max = 5): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const sym = raw.toUpperCase()
    if (sym.length < 1 || sym.length > 5) return
    if (STOPWORDS.has(sym)) return
    if (seen.has(sym)) return
    seen.add(sym)
    out.push(sym)
  }
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) push(m[1]!)
  for (const m of text.matchAll(/\b([A-Z]{1,5})\b/g)) push(m[1]!)
  return out.slice(0, max)
}

function ageText(finishedAtIso: string | null, nowMs: number): string {
  if (!finishedAtIso) return 'recently'
  const mins = Math.max(0, Math.round((nowMs - Date.parse(finishedAtIso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** One compact hint line for the system prompt. */
export function formatRecallLine(s: LatestRunSummary, nowMs: number): string {
  const verdict = s.rating
    ? `${s.rating}${s.confidence != null ? ` conf ${s.confidence}` : ''}`
    : s.status
  return `${s.symbol} — research ${ageText(s.finishedAt, nowMs)}: ${verdict} (run ${s.runId.slice(0, 8)})`
}

/**
 * Build the recent-run hint block for the tickers mentioned in ``text``.
 * Validates candidates against the watchlist OR canonical resolution to kill
 * false positives, then looks up each symbol's latest non-running run. Returns
 * '' when nothing matches — callers omit the block entirely.
 */
export async function buildRecallContext(opts: { userId: string; text: string; watchlist: string[] }): Promise<string> {
  const { getLatestRunForSymbol } = await import('../lib/agents/runs-query')
  const { resolveSymbol } = await import('../lib/yahoo')
  const candidates = extractTickerCandidates(opts.text)
  if (candidates.length === 0) return ''

  const watch = new Set(opts.watchlist.map(w => w.toUpperCase()))
  const nowMs = Date.now()
  const lines: string[] = []
  for (const cand of candidates) {
    // Cheap path: on the watchlist (bare symbol, possibly market-prefixed like US.NVDA).
    const onWatch = watch.has(cand) || [...watch].some(w => w.endsWith(`.${cand}`))
    let symbol = cand
    if (!onWatch) {
      const r = await resolveSymbol(cand)
      if (r.status !== 'resolved') continue
      symbol = r.symbol
    }
    const latest = await getLatestRunForSymbol(opts.userId, symbol)
      ?? (symbol !== cand ? await getLatestRunForSymbol(opts.userId, cand) : null)
    if (latest) lines.push(formatRecallLine(latest, nowMs))
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run the pure-function tests to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/ticker-recall.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Thread recall text through `buildSystemPrompt`**

In `apps/web/server/llm/chat-context.ts`, change the signature and append the block + a usage note. Modify the function header:

```ts
export function buildSystemPrompt(ghostfolioStatus: GhostfolioStatus, recallContext?: string): string {
```

Then, inside the returned array, add a research-recall instruction line right after the existing `'RESEARCH (agents_debate):'` block (after line 61's holdings line) — add these two array entries:

```ts
    '',
    'RESEARCH RECALL & ASYNC RUNS:',
    '- research_start kicks off a research run asynchronously and returns a runId; the user is notified in-browser when it finishes. Prefer it over agents_debate when the user says "research X" and is happy to keep chatting. Use research_status to check progress, research_get to fetch a finished run\'s rating/confidence/rationale.',
    '- If the RECENT RESEARCH RUNS block below lists a run for a ticker the user is asking about, call research_get with that runId and cite the agents\' actual assessment instead of starting a new run.',
```

And just before the final `MOOMOO_RULES` entry, append the dynamic block:

```ts
    ...(recallContext
      ? ['', 'RECENT RESEARCH RUNS (for tickers in the latest message):', recallContext]
      : []),
    '',
    MOOMOO_RULES,
```

> Remove the now-duplicated standalone `''`/`MOOMOO_RULES` tail you are replacing so `MOOMOO_RULES` appears exactly once.

- [ ] **Step 6: Build recall in `chat.post.ts` and pass it in**

In `apps/web/server/api/chat.post.ts`, after `const tools = { ...makeTools(...), ...ghostfolioTools }` (line 53), add:

```ts
  // Auto-hint: surface recent research runs for tickers in the user's latest
  // message so the model references the agents' prior assessment instead of
  // being blind to it. Best-effort — never block the chat on it.
  let recallContext = ''
  try {
    const { buildRecallContext } = await import('../llm/recall')
    const watch = await client.listWatchlist({ group: 'All' }).catch(() => [] as Array<{ code?: string }>)
    const watchSymbols = (Array.isArray(watch) ? watch : []).map(w => String(w?.code ?? '')).filter(Boolean)
    recallContext = await buildRecallContext({ userId: ownerId, text: newestUserText, watchlist: watchSymbols })
  } catch (err) {
    console.error('[chat] recall build failed', err)
  }
```

Then change the `streamText` system arg (line 60):

```ts
    system: buildSystemPrompt(ghostfolioStatus, recallContext),
```

> Confirm `client.listWatchlist` returns an array of items with a `code` field (it backs `watchlist_list` at tools.ts:122). If the shape differs, map the correct symbol field; the goal is an array of symbol strings.

- [ ] **Step 7: Typecheck + run the recall test again**

Run: `cd apps/web && npx nuxi typecheck && npx vitest run tests/unit/ticker-recall.test.ts`
Expected: no new type errors; 6 tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/server/llm/recall.ts apps/web/server/llm/chat-context.ts apps/web/server/api/chat.post.ts apps/web/tests/unit/ticker-recall.test.ts
git commit -m "feat(chat): auto-inject recent research-run hints for mentioned tickers"
```

---

## Task 6: Global done-notification tracker

**Files:**
- Create: `apps/web/composables/useActiveRuns.ts`
- Create: `apps/web/app/lib/notify.ts`
- Create: `apps/web/app/components/ActiveRunsWatcher.vue`
- Modify: `apps/web/app/layouts/default.vue`
- Test: `apps/web/tests/unit/active-runs-notify.test.ts`

**Interfaces:**
- Consumes: `ActiveRunsResponse`, `FinishedRun` (`server/lib/agents/runs-query.ts` — import the types only).
- Produces:
  - `computeNotifications(resp: ActiveRunsResponse, notified: Set<string>, cap?: number): { toNotify: FinishedRun[]; nextNotified: string[] }` (pure).
  - `useActiveRuns()` composable — starts/stops a poll loop, persists notified ids to `localStorage`, requests permission lazily, fires notifications.
  - `fireRunNotification(run: FinishedRun)` and `requestRunNotificationPermission()` (`app/lib/notify.ts`).

- [ ] **Step 1: Write the failing test for `computeNotifications`**

Create `apps/web/tests/unit/active-runs-notify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeNotifications } from '../../composables/useActiveRuns'

const resp = (finished: Array<{ runId: string; symbol: string; status: 'complete' | 'failed'; rating: string | null; confidence: number | null }>) =>
  ({ active: [], recentlyFinished: finished })

describe('computeNotifications', () => {
  it('returns finished runs not yet notified', () => {
    const r = computeNotifications(
      resp([{ runId: 'a', symbol: 'NVDA', status: 'complete', rating: 'BUY', confidence: 72 }]),
      new Set(),
    )
    expect(r.toNotify.map(x => x.runId)).toEqual(['a'])
    expect(r.nextNotified).toContain('a')
  })

  it('does not re-notify an already-notified run', () => {
    const r = computeNotifications(
      resp([{ runId: 'a', symbol: 'NVDA', status: 'complete', rating: 'BUY', confidence: 72 }]),
      new Set(['a']),
    )
    expect(r.toNotify).toEqual([])
    expect(r.nextNotified).toContain('a')
  })

  it('caps the persisted notified set to the most recent ids', () => {
    const r = computeNotifications(resp([]), new Set(['old1', 'old2', 'old3']), 2)
    expect(r.nextNotified).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd apps/web && npx vitest run tests/unit/active-runs-notify.test.ts`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement the pure reducer + composable**

Create `apps/web/composables/useActiveRuns.ts`:

```ts
import { onMounted, onUnmounted } from 'vue'
import type { ActiveRunsResponse, FinishedRun } from '../server/lib/agents/runs-query'

const NOTIFIED_KEY = 'aitrader.notifiedRuns'
const NOTIFIED_CAP = 200
const POLL_MS = 4000

/**
 * Pure reducer: given the active-runs response and the set of already-notified
 * run ids, decide which finished runs are new (need a notification) and produce
 * the next persisted notified-id list (capped, most-recent-kept).
 */
export function computeNotifications(
  resp: ActiveRunsResponse,
  notified: Set<string>,
  cap = NOTIFIED_CAP,
): { toNotify: FinishedRun[]; nextNotified: string[] } {
  const toNotify = resp.recentlyFinished.filter(r => !notified.has(r.runId))
  // Keep existing ids first, then append the newly-notified, then cap by
  // dropping the oldest (front).
  const merged = [...notified, ...toNotify.map(r => r.runId)]
  const nextNotified = merged.slice(Math.max(0, merged.length - cap))
  return { toNotify, nextNotified }
}

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
function saveNotified(ids: string[]) {
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

export function useActiveRuns() {
  let timer: ReturnType<typeof setInterval> | null = null
  let permissionAsked = false

  async function tick() {
    let resp: ActiveRunsResponse
    try {
      const r = await fetch('/api/research/active-runs', { headers: { 'content-type': 'application/json' } })
      if (!r.ok) return
      resp = await r.json() as ActiveRunsResponse
    } catch {
      return
    }

    const { requestRunNotificationPermission, fireRunNotification } = await import('../app/lib/notify')
    // Ask for permission lazily the first time a run is in flight.
    if (!permissionAsked && resp.active.length > 0) {
      permissionAsked = true
      void requestRunNotificationPermission()
    }

    const notified = loadNotified()
    const { toNotify, nextNotified } = computeNotifications(resp, notified)
    if (toNotify.length === 0) return
    for (const run of toNotify) fireRunNotification(run)
    saveNotified(nextNotified)
  }

  onMounted(() => {
    void tick()
    timer = setInterval(() => { void tick() }, POLL_MS)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
}
```

> Path note: the composable imports `../app/lib/notify` (the notify helper lives under `app/lib/`). Adjust the relative path if your tsconfig path aliases differ; the test only imports `computeNotifications`, which has no DOM/Notification dependency.

- [ ] **Step 4: Run the reducer test to confirm pass**

Run: `cd apps/web && npx vitest run tests/unit/active-runs-notify.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the notification helper**

Create `apps/web/app/lib/notify.ts`:

```ts
import type { FinishedRun } from '../../server/lib/agents/runs-query'

export async function requestRunNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch { /* ignore */ }
  }
}

export function fireRunNotification(run: FinishedRun): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const done = run.status === 'complete'
  const verdict = run.rating
    ? `${run.rating}${run.confidence != null ? ` · conf ${run.confidence}` : ''}`
    : run.status
  const n = new Notification(`${run.symbol} research ${done ? 'done' : 'failed'}`, {
    body: done ? verdict : 'the run did not complete',
    tag: `research-${run.runId}`,
  })
  n.onclick = () => {
    window.focus()
    window.location.href = `/research?run=${encodeURIComponent(run.runId)}`
    n.close()
  }
}
```

- [ ] **Step 6: Create the headless watcher component**

Create `apps/web/app/components/ActiveRunsWatcher.vue`:

```vue
<script setup lang="ts">
// Headless: mounts the global active-runs poll loop so research-run completion
// notifications fire on any page (chat included), regardless of where the run
// was started. Renders nothing.
import { useActiveRuns } from '../../composables/useActiveRuns'
useActiveRuns()
</script>

<template>
  <span style="display: none" aria-hidden="true" />
</template>
```

- [ ] **Step 7: Mount it in the layout**

In `apps/web/app/layouts/default.vue`, add the component inside `.app-shell` (e.g. right after `<AppShellHeader ... />`):

```vue
    <ActiveRunsWatcher />
```

(Nuxt auto-imports components from `app/components`, so no explicit import is needed in the template.)

- [ ] **Step 8: Typecheck + full unit suite**

Run: `cd apps/web && npx nuxi typecheck && npx vitest run`
Expected: no new type errors; all tests (including the 4 new files) pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/composables/useActiveRuns.ts apps/web/app/lib/notify.ts apps/web/app/components/ActiveRunsWatcher.vue apps/web/app/layouts/default.vue apps/web/tests/unit/active-runs-notify.test.ts
git commit -m "feat(research): global browser-notification tracker for finished runs"
```

---

## Task 7: End-to-end verification in the running app

**Files:** none (verification only).

- [ ] **Step 1: Rebuild containers**

Run: `docker compose up -d --build web api`
Expected: both come up healthy.

- [ ] **Step 2: Verify async trigger from chat**

In the chat UI, send: `research NVDA`.
Expected: the model calls `research_start`, replies that the run started and you'll be notified; chat is NOT blocked. Confirm a new `agent_runs` row exists with status `running` (DB or `/research/runs`).

- [ ] **Step 3: Verify the notification**

Grant the notification permission when prompted. Navigate to the chat page (away from research). When the run finishes (~30-90s), confirm a native OS notification `NVDA research done · <rating> · conf <n>` appears. Click it → lands on `/research?run=<id>` showing the completed run.

- [ ] **Step 4: Verify UI-started runs also notify**

Start a run from the research page UI for a different symbol, then switch to the chat page. Confirm the completion notification still fires (proves the tracker is origin-agnostic).

- [ ] **Step 5: Verify recall**

In a fresh chat, ask: `should I trim NVDA?`
Expected: the model references the prior run's assessment (rating/confidence/rationale), having called `research_get` off the auto-injected hint — without you pasting anything. Verify it did NOT start a brand-new run.

- [ ] **Step 6: Negative check — no false-positive recall**

Ask a message with no real ticker (e.g. `is it a good time to buy?`). Expected: no recent-run block leaks into behavior; the model does not hallucinate a run reference.

- [ ] **Step 7: Commit (if any verification-driven fixes were needed)**

```bash
git add -A && git commit -m "fix(research): address e2e verification findings"
```

---

## Self-Review

**Spec coverage:**
- Async trigger (spec §1) → Tasks 1–2 (`startAgentRun`, `drainIntoTee`, `agents-run-async`, `research_start`). ✓
- Detached-promise rationale (spec §1) → `drainIntoTee` doc + endpoint comment. ✓
- Native Notification, tab-open, lazy permission, click→`/research?run=` (spec §2) → Task 6. ✓
- Notify UI-started runs too (spec §2 bonus) → `active-runs` lists all running rows; Task 7 step 4 verifies. ✓
- Survives refresh via localStorage (spec §2) → `loadNotified`/`saveNotified`. ✓
- Hybrid recall: auto-hint + lookup tool (spec §3) → Task 5 (`buildRecallContext`) + Task 4 (`research_get`). ✓
- Ticker validation against watchlist + `resolveSymbol` to kill false positives (spec §3) → `buildRecallContext`; tested in `extractTickerCandidates`. ✓
- `research_status` (spec §3 tools) → Task 2. ✓
- Error handling: async start failure synchronous, drain failure → row failed, permission denied silent, recall errors → inject nothing (spec Error handling) → `startAgentRun` throws pre-detach; `drainIntoTee` try/catch; `fireRunNotification` permission guard; `chat.post.ts` try/catch. ✓
- Testing matrix (spec) → pure TDD targets: `splitNdjson`, `shapeActiveRuns`, `summarizeRunRow`, `extractTickerCandidates`/`formatRecallLine`, `computeNotifications`; tool tests via fetch mocks. ✓

**Placeholder scan:** No TBD/TODO/"add error handling" — all code blocks are concrete. ✓

**Type consistency:** `AgentsRunBody`, `StartedRun`, `ActiveRunsResponse`/`ActiveRun`/`FinishedRun`, `LatestRunSummary`/`RunAssessment`, `computeNotifications` signature, tool return shapes (`status:'already_running'|'running'|'error'`) are defined once and referenced consistently across tasks. `confidence` is a stored integer (0–100), displayed as `conf 72` everywhere (not `0.72`). `inArray` import note resolved in Task 4. ✓

**Scope:** Single cohesive feature, one plan. ✓
