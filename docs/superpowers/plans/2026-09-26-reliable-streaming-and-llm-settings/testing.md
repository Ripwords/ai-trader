# Testing and runtime verification

Back to [overview](./overview.md).

## Repro scripts (write first, must fail before the fix)

Kept in `scripts/repro/`, run against the local compose stack.

1. **Chat drop and resume.** Playwright: send a chat that triggers a slow tool; after the first text chunk, set the page offline for 5 s, go online. Expected after fix: the same reply completes in place, one assistant message in the DB. Before: no further text, reply appears only after reload.
2. **Chat duplicate thread.** Send a message on a new chat, reload before the first chunk. Expected after fix: one thread. Before: second send creates a second thread.
3. **Debate idle cut.** Stub api node that sleeps 330 s (env-gated test hook). Expected after fix: heartbeats keep the stream alive; run completes. Before: web logs `terminated`/`UND_ERR_BODY_TIMEOUT`, run stuck `running`.
4. **Debate refresh.** Start a debate, reload mid-run. Expected after fix: events replay and continue live without `?run=`. Before: page shows stale state or polls forever.
5. **Debate api restart.** `docker compose restart api` mid-run. Expected after fix: run shows `failed` with Retry within seconds. Before: `running` forever.
6. **Resume persists.** Resume an interrupted run. Expected after fix: resumed events appear after refresh. Before: `agent_messages_run_seq_uq` errors in web logs.

## Settings verification

- Add Anthropic key, select model, chat works; remove `ANTHROPIC_API_KEY` from `.env`, rebuild, chat still works.
- Add an OpenAI-compatible provider with a custom base URL (local Ollama if available, otherwise OpenRouter); test connection lists models.
- `psql`: `select api_key from llm_providers` shows base64 ciphertext, not the key.
- Debate run completes with keys only in the DB.
- Visual: screenshots of settings list, add modal, test result, error states; check right edge and bottom of the list.

## Commands

- `cd apps/web && npx vitest run && npx nuxi typecheck`
- `cd apps/api && uv run pytest`
- `docker compose up -d --build web api`
