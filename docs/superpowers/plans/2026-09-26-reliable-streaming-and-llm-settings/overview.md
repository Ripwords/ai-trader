# Reliable chat/debate streaming and in-app LLM settings

> **For agentic workers:** execute phase by phase with superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Each phase ends green (tests + typecheck) and is committed before the next starts.

## Context

Two complaints, one root pattern for the first.

1. **Chat and the agent debate are unreliable.** Replies don't appear until refresh, get cut short, or duplicate. Investigation (2026-09-26) found the generation is tied to a fragile HTTP connection while the server always finishes and saves the reply:
   - Chat: 26 s of pre-header prep (MCP connect, watchlist) with no timeouts; long silent gaps during tool calls; nginx on ripwords-dell drops idle streams (default `proxy_read_timeout` 60 s); the server keeps generating and saves in `onFinish`, but the UI only logs the error to the console and has no reconnect. Saved threads show the fingerprint: question, user "so?", then two assistant replies. A new chat whose thread id never reached the browser spawns a duplicate thread.
   - Debate: the api emits nothing while an LLM node thinks (minutes); Node `fetch` (undici) kills the web→api body after 300 s idle; the inline route then never ends the browser response and never marks the run failed, so the page and the DB row stay `running` forever. Resume writes fail on the `(run_id, seq)` unique index because the tee restarts at seq 0, and resume drops the run's original options.
2. **LLM config lives in `.env`.** Switching provider or key needs a rebuild. Users want to add providers, keys, and base URLs in the app, with keys encrypted at rest.

## Scope

In:
- Decouple generation from the browser connection for chat and debate: a run always reaches a terminal state, the browser can reconnect and replay, and errors are visible with retry.
- Keepalives on every long stream (chat, debate, api→web).
- A Settings page to add providers (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, and "OpenAI-compatible" with custom base URL such as Ollama/LM Studio), store keys encrypted (AES-256-GCM, ported from `~/Documents/sbf/src/lib/encryption.ts`), pick the chat model and the quick model.
- The Python api gets credentials from web, not env.
- Remove LLM keys/model from `.env`, compose, and the README in the same change; one-time import of existing env values on first boot.

Out:
- nginx config on ripwords-dell (not in the repo). Keepalives make the 60 s default harmless; raising `proxy_read_timeout` is noted as an optional ops step in the README.
- Redis or any new infra. Web runs as one Nitro process, so the replay buffer is in-process.
- Multi-user key scoping (the app is single-user; rows still carry `owner_id` for consistency with the schema).

## Constraints

- TDD, no `any`, Conventional Commits (CLAUDE.md).
- `docker compose up -d --build web|api` after edits; tests locally: `cd apps/web && npx vitest run`, `npx nuxi typecheck`; `cd apps/api && uv run pytest`.
- Modals via Nuxt UI `useOverlay`, never `window.confirm`.
- Keys never leave the server decrypted except over the bearer-guarded internal route to the api. The settings API returns a masked hint (`…abcd`) only.
- `ENCRYPTION_KEY` is a new, dedicated secret. Not `SESSION_SECRET` (rotating the session would brick stored keys).

## Alternatives considered

| Streaming approach | Verdict |
|---|---|
| Patch symptoms only: keepalives + longer timeouts + show errors | Fixes the cut-offs, not "nothing shows until refresh" after any disconnect or restart. Rejected as the whole fix; kept as layer 1. |
| **Detached run + event log + replayable subscribe (chosen)** | Generation runs independently of the request; every chunk goes to a buffer (chat, in-process) or `agent_messages` (debate, already persisted). Browser subscribes with `?after=seq` and resumes on drop. AI SDK v6 already supports this for chat via `resumeStream` / `GET /api/chat/:id/stream`. The debate async path (`drainIntoTee`) already exists; the inline path gets deleted in favour of it. |
| AI SDK `resumable-stream` package | Requires Redis. Not worth new infra for a single-process app. |

| API key delivery to Python | Verdict |
|---|---|
| Python reads DB and decrypts | Duplicates crypto and `ENCRYPTION_KEY` in two runtimes. |
| Web sends keys in each run request body | Works, but every web→api call site must remember to send them. |
| **api fetches `GET /api/internal/llm-config` from web at run start (chosen)** | Matches the existing `WEB_INTERNAL_BASE_URL` + `INTERNAL_BEARER` callback pattern; crypto stays in web only. TradingAgents' `build_chat_model` takes no `api_key`, so the api wraps it to inject `api_key`/`base_url` per run instead of mutating `os.environ` (process-global, races concurrent runs). |

## Phases

Workstream A ships first because it is the user-facing pain. Workstream B is independent except B6 touches the api graph builder that A1 also touches; run A1 before B6.

- [Workstream A: streaming reliability](./workstream-a-streaming.md) (A1 to A7)
- [Workstream B: LLM provider settings](./workstream-b-llm-settings.md) (B1 to B7)
- [Testing and runtime verification](./testing.md)

## Verification

- `cd apps/web && npx vitest run && npx nuxi typecheck`
- `cd apps/api && uv run pytest`
- Runtime via the `verify` skill against `docker compose up -d --build web api`: the repro scripts in [testing.md](./testing.md), run before the fix (must fail) and after (must pass).

## Implementation guidance

- `how` over each subsystem before changing it (`chat.post.ts` + `app/pages/index.vue`; `server/lib/agents/*` + `apps/api/app/routers/agents.py`).
- Model the domain: a run is a state machine `queued → running → (complete | failed | cancelled)`; every code path that ends a stream must land in a terminal state. No scattered `status` booleans in the UI.
- Boundary discipline: parse provider settings with zod at the API boundary; internal code trusts the typed `ResolvedModel`.
- Migrate callers then delete: `buildModel(process.env.LLM_MODEL)` and every `os.environ["LLM_MODEL"]` read are removed in the phase that introduces the resolver, not later.
- `/deslop` over each diff before commit; `unslop` on the README changes.
- `interrogate` on phase A5 (chat resume design) before shipping; it is the contested piece.
