# Workstream A: streaming reliability

Back to [overview](./overview.md).

## A1. Keepalives and timeouts on the debate path

**Goal.** No stream between api, web, and browser is ever silent long enough to be cut.

**Changes.**
- `apps/api/app/routers/agents.py`: emit a `{"kind":"heartbeat"}` NDJSON line every 15 s while a graph node is running (merge the graph iterator with a ticker). Heartbeats are not persisted.
- `apps/web/server/lib/agents/start-run.ts`, `server/api/research/agents-resume.post.ts`: use an undici `Agent` with `bodyTimeout: 0` and `headersTimeout` of 60 s for the api fetch (one shared dispatcher in `server/utils/`).
- `apps/web/server/utils/agents-tee.ts`: drop heartbeat lines before persisting.
- `apps/api/app/services/agents/model_config.py`: set a per-call LLM timeout (e.g. 180 s) and 2 retries so a hung provider call becomes an `error` event instead of an eternal wait.

**Data structures.** `AgentEvent` union gains `heartbeat` (transport-only).

**Verification.** pytest: a fake slow node yields heartbeats at the configured interval. vitest: tee filters heartbeats.

## A2. One detached run path for the debate

**Goal.** The debate never depends on the browser connection. Every run reaches a terminal state.

**Changes.**
- `server/api/research/agents-run.post.ts`: stop proxying the stream. Start via `startAgentRun` + `drainIntoTee` (the async path), return `{ runId }`. Delete the inline tee code.
- `server/lib/agents/start-run.ts` (`drainIntoTee`): if the upstream ends or throws without `run-end`, write an `error` event and mark the run `failed`. Always.
- New `server/api/research/agent-events.get.ts`: SSE that replays `agent_messages` after `?after=seq`, then tails new rows (poll the table every 1 s server-side, or LISTEN/NOTIFY if trivial), sends `: ping` every 15 s, closes after `run-end`/`error`.
- On web boot (Nitro plugin): mark `running` runs with no event in 15 min as `failed` (replaces the sweep that only runs when a new run starts on the same symbol).

**Data structures.** `RunStatus = 'running' | 'complete' | 'failed' | 'cancelled'` stays; the invariant is "every path writes a terminal status".

**Verification.** vitest: `drainIntoTee` with an upstream that closes early marks failed and appends an error event; the SSE handler replays from `after` and stops at `run-end`.

## A3. Client consumes the debate by subscription

**Goal.** Refresh, network drop, or tab switch resumes the debate where it left off.

**Changes.**
- `app/composables/useAgentsRun.ts`: replace `consumeStream` + 2 s poll with `EventSource(agent-events?runId&after=lastSeq)`; on error, reconnect with backoff using the last seen seq. A stream that closes without `run-end` shows as failed with a Retry.
- `app/pages/research/[symbol].vue`: follow the active run for the symbol even without `?run=` (use `active-runs`), so runs started from chat or another tab appear live.

**Verification.** happy-dom vitest for the reducer (`events → view state`), including dedupe by seq on replay overlap.

## A4. Resume correctness

**Goal.** Resumed runs persist their events and match the original configuration.

**Changes.**
- `server/api/research/agents-resume.post.ts`: seed the tee's seq with `max(seq)+1` for the run; go through `drainIntoTee`.
- `apps/api/app/routers/agents.py` resume handler: rebuild the graph with the run's stored options (`reasoning_effort`, `response_language`, `selected_analysts`, `max_risk_discuss_rounds`). Web persists these on `agent_runs` if not already there and passes them on resume.

**Verification.** vitest: resumed tee writes start after the existing max seq. pytest: resume passes stored options to the graph builder.

## A5. Chat generation detached from the request, resumable

**Goal.** A chat reply survives a dropped connection; the browser reconnects and sees the rest.

**Changes.**
- New `server/lib/chat-streams.ts`: in-process registry `Map<threadId, ActiveChatStream>`; each holds the ordered UI-message chunks produced so far, a status, an `AbortController`, and subscriber set. Entries expire 5 min after finish.
- `server/api/chat.post.ts`: create/confirm the thread and send the thread id as the first chunk before any slow prep; run `streamText` with the registry's `abortSignal`; call `result.consumeStream()` so generation continues regardless of the client; tee `toUIMessageStream()` into the registry; the response is a subscription to it. Emit an SSE comment ping every 15 s.
- New `server/api/chat/[id]/stream.get.ts`: AI SDK's reconnect endpoint. 204 if no active stream; otherwise replay buffered chunks then tail.
- New `server/api/chat/[id]/stop.post.ts`: aborts the server generation (Stop now really stops; partial reply is saved with a "stopped" marker).

**Data structures.** `ActiveChatStream { threadId; chunks: UIMessageChunk[]; status: 'streaming'|'done'|'error'|'aborted'; abort: AbortController; listeners: Set<…> }`.

**Verification.** vitest: registry replays all chunks to a late subscriber; abort ends with `aborted`; two concurrent subscribers see identical sequences. `interrogate` the design before merge.

## A6. Chat pre-flight bounded

**Goal.** Headers and the first chunk arrive in under 1 s regardless of MCP or watchlist health.

**Changes.**
- `server/api/chat.post.ts` lines ~33-83: move context prep (MCP tools, watchlist, recall) after the first chunk; wrap each in a timeout (MCP connect 3 s, watchlist 2 s, recall 800 ms as today).
- `server/…/mcp.ts`: cache a failed MCP connect for 60 s (negative cache) instead of retrying per message; cache the tool list.

**Verification.** vitest with fake slow MCP/watchlist: first chunk emitted before they resolve; chat proceeds without MCP tools when it times out.

## A7. Chat UI states

**Goal.** Users see what is happening and can recover.

**Changes.**
- `app/pages/index.vue`: `useChat({ resume: true })` with the default transport's reconnect endpoint; on stream error, attempt one resume, then show an inline error card with Retry (regenerate) in the thread, not just the prompt's red border.
- Block sending while the server says a generation is active for the thread (registry status via the resume endpoint), which removes the duplicate-reply pattern.
- Stop button calls `stop.post.ts` as well as `chat.stop()`.

**Verification.** `verify` skill: send a message, kill the connection mid-stream (DevTools offline, or restart the browser tab), reconnect, reply completes in place with no duplicate. Screenshot the error card.
