# Streaming repro scripts

Runtime checks for the streaming reliability work. Run them from the repo root
against the local compose stack after `docker compose up -d --build web api`.
Each prints `PASS:` or `FAIL:` and exits non-zero on failure.

| Script | Checks | Needs |
|---|---|---|
| `scripts/repro/1-chat-drop-resume.mjs` | A chat reply completes in place after 5 s offline, saved once | a working chat model |
| `scripts/repro/2-chat-duplicate-thread.mjs` | Reloading a new chat before its first chunk keeps one thread | a working chat model, no other chat activity |
| `scripts/repro/3-debate-idle-cut.sh` | A debate node silent for 330 s does not cut the stream | nothing (stub api) |
| `scripts/repro/4-debate-refresh.sh` | Reloading `/research/AAPL` mid-run replays and follows it | nothing (stub api) |
| `scripts/repro/5-debate-api-restart.sh` | Restarting the api mid-run ends the run as failed | nothing (stub api) |
| `scripts/repro/6-resume-persists.sh` | Resuming an interrupted run appends events with contiguous seqs | nothing (stub api) |

The debate scripts recreate the api with `compose.stub.yml`, which sets
`AGENTS_STUB_RUN_SECONDS`. The api then runs a stub graph that sleeps that many
seconds in one node and decides `hold`, without calling a model. Each script
puts the api back to its normal configuration on exit. The `.mjs` scripts use
the Playwright install under `apps/web`. Set `HEADED=1` to watch them.
