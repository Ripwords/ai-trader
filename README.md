# ai-trader

Self-hosted trading copilot. Chat with an AI that has tools for moomoo market data + (later) Ghostfolio portfolio + algo trading.

**Plans 1 + 2 complete.** End-to-end:

- Log in (single password), see your moomoo watchlist in the sidebar.
- Ask `show NVDA daily` → real candlestick chart inline.
- Ask `what's on my watchlist?` → list pulled from your real moomoo account.
- Ask `add US.AAPL to my watchlist` / `remove US.NVDA` → mutates moomoo's watchlist.
- Ask `any news on NVDA?` → Tavily-powered news cards.
- Ask `show me my portfolio` → real positions + cash from your paper or live moomoo account (read-only).

## Prereqs

- Docker Desktop (or compose v2)
- moomoo OpenD installed on the host machine and **logged in**, listening on `127.0.0.1:11111`
- Anthropic API key
- (Optional but recommended) Tavily API key for news/web search — without it, search tools surface a clean error message and the rest still works

## First run

```sh
cp .env.example .env
# Edit .env:
#   APP_PASSWORD       — what you type to log in (anything)
#   SESSION_SECRET     — at least 32 random bytes
#   INTERNAL_BEARER    — random string, used between Nuxt and FastAPI
#   ANTHROPIC_API_KEY  — real sk-ant-… key
#   TAVILY_API_KEY     — tvly-… key for news/web search (optional)
#   POSTGRES_PORT      — host port for postgres (default 5432; override if 5432 is taken)

docker compose up -d --build
open http://localhost:3000
```

Sign in with `APP_PASSWORD`, then type `Show me NVDA daily` in the chat box.

If the chat returns an error like `Could not find API key process.env.ANTHROPIC_API_KEY`, your `ANTHROPIC_API_KEY` is the placeholder. Edit `.env` and `docker compose up -d --build web` again.

## Stop / clean up

```sh
docker compose down       # keep DB volume
docker compose down -v    # also wipe DB volume (resets users / chat history)
```

## Repo layout

```
apps/
  web/                 # Nuxt 4 + Nuxt UI v4 + Mastra (chat orchestration)
    app/               # Nuxt 4 layout: components, pages, layouts
    server/            # Nitro routes, middleware, mastra agent + tools
    db/                # Drizzle schema + migrations
    tests/             # vitest unit + playwright e2e
  api/                 # FastAPI wrapping moomoo OpenD
    app/               # routers, services, schemas
    tests/             # pytest
docs/superpowers/
  specs/               # design docs (one per feature)
  plans/               # implementation plans (one per phase)
  morning-questions.md # decisions log from autonomous build sessions
docker-compose.yml
```

## Architecture

```
┌──────────────── docker compose ────────────────┐
│  web (Nuxt 4 + Mastra) :3000   →  agent.stream │
│  api (FastAPI)         :8000   →  moomoo SDK   │
│  drizzle-migrate (one-shot)                    │
│  postgres (16-alpine)          :5432 (in-net)  │
└────────────────────────────────────────────────┘
        │                       │
        │ host.docker.internal  │ Anthropic API
        ▼                       ▼
   moomoo OpenD (host)   Claude Sonnet 4.6
```

- The Nuxt server runs Mastra agents and proxies to FastAPI for moomoo data.
- FastAPI is **stateless**; all persistence is owned by Drizzle/Postgres on the Nuxt side.
- The Mastra agent streams **NDJSON** chunks (`text-delta`, `tool-call`, `tool-result`, `finish`, `error`) which the chat UI parses inline.

## Tests

```sh
# api: pytest with fake OpenD client (no live OpenD needed)
cd apps/api && uv run pytest

# web: vitest unit
cd apps/web && pnpm exec vitest run

# web: playwright e2e (requires the docker stack running + a real ANTHROPIC_API_KEY)
cd apps/web && pnpm exec playwright test
```

The e2e test passes if either a chart canvas OR an inline error message appears — so it works with both real and placeholder API keys.

## What's next (later plans)

- Plan 3: paper trading (place/modify/cancel orders via chat) + push subscriptions (live ticker / orderbook streaming)
- Plan 4: options chain viewer + screener UI + Ghostfolio MCP integration
- Plan 5: algo backtesting via backtrader + scheduled live algo strategies
- Plan 6: live broker trading (with confirmation gates) + polish
