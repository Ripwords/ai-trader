# Chat-triggered async research, done-notification, and run recall

**Date:** 2026-06-28
**Status:** Approved (design), pending implementation plan

## Problem

A research run (the multi-agent LangGraph pipeline) can be started from the
research UI or, today, via the inline `agents_debate` chat tool that **blocks
chat for minutes**. Two gaps hurt daily use:

1. **No async trigger + no completion signal.** There is no fire-and-forget way
   to kick a run from chat and be told when it finishes. Runs are inline-streamed
   and the API kills a run on client disconnect, so chat cannot simply "not await."
2. **Chat is blind to existing runs.** When a run was started elsewhere (e.g. the
   research page), the chat agent has zero awareness of it. The user had to
   manually paste/explain the agent's assessment to get chat "up to speed."

## Goals

- From chat, start a research run on a ticker **asynchronously** (returns a run id
  immediately; chat keeps flowing).
- Show a **native browser notification** (`Notification` Web API) when a run
  completes — for runs started from chat **and** from the research UI.
- Make chat **automatically aware** of recent runs for any ticker the user
  mentions, and able to cite the agent's actual assessment.

## Non-goals (YAGNI)

- Web Push / service workers / notifications when the app is fully closed.
  (Native Notification API only — fires while a tab is open, even backgrounded.)
- A standalone local MCP server. "MCP" in the original ask is a loose framing;
  the trigger is implemented as a chat tool reusing the existing tool pattern.
- Replacing the existing inline `agents_debate` tool. It stays as-is for users who
  want to watch the stream live.

## Existing architecture (reference)

- Run trigger (inline stream): `apps/web/server/api/research/agents-run.post.ts`
  — resolves symbol, creates `agentRuns` row, streams NDJSON from FastAPI
  `POST /agents/run`, and tees events into `agentMessages` via `AgentRunTee`.
- Data model: `apps/web/db/schema.ts`
  — `agentRuns` (status running/complete/failed/cancelled, symbol, config,
  tokens, cost, finalState), `agentMessages` (per-seq events),
  `agentDecisions` (rating BUY/SELL/HOLD, confidence, rationale).
- Incremental polling: `GET /api/research/agent-messages?run_id=X&since=N`
  returns `{ runId, status, startedAt, finishedAt, lastSeq, events }`.
- Frontend run polling today: `apps/web/composables/useAgentsRun.ts` polls every
  2s while a run is `running`.
- Chat tools: `apps/web/server/llm/tools.ts` (`makeTools()` factory, ~22 tools),
  self-fetch internal APIs forwarding the `session` cookie via `options.event`.
- Chat endpoint: `apps/web/server/api/chat.post.ts` (`streamText`, Vercel AI SDK).
- Deployment: Docker (long-lived Node/Nitro), **not serverless** — detached
  promises survive the response.

## Design

### 1. Async run execution

New endpoint **`POST /api/research/agents-run-async`**.

- Reuses the symbol resolution + `agentRuns` row creation + FastAPI streaming +
  `AgentRunTee` persistence logic already in `agents-run.post.ts`. Refactor the
  shared run-start logic into a helper (e.g. `server/lib/agents/startRun.ts`) that
  both the inline and async endpoints call, to avoid duplication.
- Instead of piping the NDJSON stream back to the client, it **drains the stream
  into the DB in a `void`ed (detached) promise** and returns
  `{ runId, status: 'running' }` immediately.
- Detached promise rationale: the app runs under a long-lived Node process in
  Docker, so work started with `void drain()` continues after the HTTP response
  completes. The API's client-disconnect kill does **not** apply because the
  server-side consumer keeps reading the stream to completion.
- Error handling: if run creation fails, return the error synchronously (4xx/5xx).
  If the detached drain fails mid-run, the `agentRuns` row is marked `failed` by
  the existing tee/finalization path; the active-runs tracker surfaces it as a
  failed notification.

### 2. Done-notification (global, poll-based)

New composable **`useActiveRuns`** mounted in the app shell (default layout /
`app.vue`) so it runs on every page, including chat.

- Maintains a set of tracked in-flight run ids for the current user, persisted to
  `localStorage` (survives refresh/navigation).
- Sources of tracked ids: (a) `research_start` tool result, (b) runs started from
  the research UI, (c) on mount, any `agentRuns` still `running` for the user
  (recovery). A small `GET /api/research/active-runs` returns currently-running
  run ids+symbols for the user to seed (c).
- Polls each tracked run via the existing `agent-messages` endpoint every ~3s.
- On transition to `complete`/`failed`: fire one
  `new Notification(`${symbol} research ${done|failed}`, { body: 'BUY · conf 0.72' })`,
  dedupe so it fires exactly once per run, remove from the tracked set. Click →
  navigate to `/research?run=<id>`.
- Permission: request `Notification.requestPermission()` lazily on first run start
  (not on app load). If denied/unsupported, degrade silently (run still completes;
  no notification).

### 3. Run recall in chat (hybrid)

**Auto-hint** (in `chat.post.ts`, before `streamText`):

- A `tickerRecall` helper scans the latest user message for ticker mentions:
  `$SYM` cashtags and bare uppercase tokens 1–5 chars.
- Validate candidates to kill false positives ("A", "I", "OK"): keep a token only
  if it is on the user's watchlist OR resolves via `resolveSymbol`. Cashtags are
  trusted more readily but still resolved.
- For each validated symbol, fetch the latest non-running `agentRuns` (+ joined
  `agentDecisions`) and inject a compact system line into the chat context:
  `NVDA — research 2h ago: BUY conf 0.72 (run abc123)`. Cap at a few tickers per
  message to bound tokens. No matching runs → inject nothing.

**Tools** (added to `makeTools()`):

- `research_start({ symbol })` — calls `agents-run-async`, returns
  `{ runId, status }` and a card noting "run started, you'll be notified."
- `research_status({ runId })` — returns current status from `agent-messages`.
- `research_get({ runId? , symbol? })` — returns the full assessment (decision
  rating/confidence/rationale + relevant `finalState` summary) for the LLM to
  cite. If only `symbol` given, resolves to the latest completed run.

## Data flow

```
chat: "research NVDA"
  -> tool research_start(NVDA)
     -> POST /api/research/agents-run-async
        -> create agentRuns row (running)
        -> void drainStreamIntoDB()   // detached, survives response
        -> return { runId, status:'running' }
  -> chat continues; useActiveRuns starts tracking runId
  ... time passes ...
  useActiveRuns poll -> status complete
     -> Notification('NVDA research done · BUY conf 0.72')
        -> click -> /research?run=<id>

later, chat: "should I trim NVDA?"
  -> tickerRecall injects: "NVDA — research 2h ago: BUY conf0.72 (run abc)"
  -> LLM calls research_get(abc) -> full thesis -> cites assessment
```

## Components & boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/lib/agents/startRun.ts` | shared run-start (resolve, row, stream, tee) | existing tee, FastAPI |
| `agents-run-async.post.ts` | detached starter → `{ runId }` | startRun helper |
| `active-runs.get.ts` | list user's running run ids+symbols | `agentRuns` |
| `useActiveRuns` composable + shell mount | poll in-flight, fire notifications, persist | `agent-messages`, `active-runs` |
| `research_start/_status/_get` tools | chat-facing trigger + lookup | async endpoint, `agent-messages` |
| `tickerRecall` helper in `chat.post.ts` | detect+validate tickers, inject hints | watchlist, `resolveSymbol`, `agentRuns`/`agentDecisions` |

## Error handling

- Async start failure → synchronous 4xx/5xx to the tool; tool surfaces a clear card.
- Detached drain failure → row marked `failed`; notification says "failed".
- Notification permission denied/unsupported → silent degrade.
- Ticker recall: validation failure or DB error → inject nothing (never block chat).

## Testing

- **API/server (TDD):**
  - `startRun` helper creates an `agentRuns` row and returns a run id without
    blocking on stream completion.
  - `tickerRecall`: matches `$NVDA` and `NVDA`; rejects "A"/"I"/lowercase/unknown
    symbols; respects the per-message cap; returns nothing when no runs exist.
  - `research_get` resolves by runId and by symbol→latest-completed.
- **Web (TDD):**
  - `useActiveRuns`: running→complete fires exactly one notification; dedupes a
    run already notified; resumes tracked ids from localStorage on mount; seeds
    from `active-runs` on mount.

## Open questions

None outstanding. (Decisions locked: in-chat async tool, native Notification API,
hybrid recall, notify UI-started runs too.)
