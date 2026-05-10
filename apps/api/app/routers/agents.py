"""POST /agents/run — synchronous NDJSON stream of a TradingAgents run.

Persistence (Task 8): when ``app.state.checkpointer`` is wired (lifespan opens
an :class:`AsyncPostgresSaver`), every run writes LangGraph checkpoints scoped
to ``thread_id == run_id``. Two endpoints leverage that:

- ``POST /agents/run/{run_id}/resume`` — replay from the latest checkpoint
  (LangGraph's ``astream(None, config={"configurable": {"thread_id": run_id}})``).
- ``DELETE /agents/run/{run_id}`` — cancel an in-flight run via a
  process-local task registry. Returns ``cancelled=False`` for unknown ids
  (no error: the registry is intentionally short-lived).

Reflection recall is still wired in via
:class:`app.services.agents.memory.PostgresMemoryProvider` when an asyncpg
pool is available on ``app.state.pg_pool``; without a pool, runs proceed with
empty memory.

The cancellation registry (:data:`_active_runs`) is **process-local** — fine
for v1's single-process api container, but wrong for a scaled-out deployment.
A scaled deployment needs a broadcast cancel signal (Postgres LISTEN/NOTIFY,
Redis pub/sub, etc); call out the assumption when scaling planning happens.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import date as date_t
from typing import Any, AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.schemas.agents import RunRequest
from app.services.agents import graph as graph_mod
from app.services.agents import reflection as reflection_mod
from app.services.agents.cost_cap import DailyCapExceeded, assert_under_daily_cap
from app.services.agents.memory import PostgresMemoryProvider
from app.services.agents.streaming import translate_chunks
from app.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agents", tags=["agents"])


# Process-local registry of in-flight ``run_id -> asyncio.Task`` pairs. Only
# populated by :func:`run_agents` while a stream is live; entries are cleared
# in the streaming finally-block.
_active_runs: dict[str, asyncio.Task[Any]] = {}


def _check_bearer(authorization: str | None) -> None:
    settings = get_settings()
    if authorization != f"Bearer {settings.INTERNAL_BEARER}":
        raise HTTPException(status_code=401, detail="Unauthorized")


async def _recall_memory(
    request: Request, user_id: str | None, symbol: str
) -> list[dict]:
    """Fetch prior reflections for (user, symbol). Returns ``[]`` if unavailable.

    ``x-user-id`` is forwarded by the Nuxt server proxy
    (``apps/web/server/api/research/agents-run.post.ts``) and trusted because
    the upstream endpoint sits behind ``INTERNAL_BEARER`` — only our own web
    container can reach it.
    """
    pool = getattr(request.app.state, "pg_pool", None)
    if pool is None or not user_id:
        return []
    try:
        provider = PostgresMemoryProvider(pool)
        return await provider.recall(user_id=user_id, symbol=symbol, k=5)
    except Exception as e:  # noqa: BLE001
        # Memory recall is best-effort — a DB hiccup shouldn't block the run.
        logger.warning("memory recall failed for %s/%s: %s", user_id, symbol, e)
        return []


@router.post("/run")
async def run_agents(
    body: RunRequest,
    request: Request,
    authorization: str | None = Header(default=None),
    x_user_id: str | None = Header(default=None, alias="x-user-id"),
) -> StreamingResponse:
    _check_bearer(authorization)
    run_id = str(uuid.uuid4())
    trade_date = body.trade_date or date_t.today()

    async def _stream() -> AsyncIterator[bytes]:
        # Register the current task so DELETE /agents/run/{run_id} can cancel
        # it. We register inside ``_stream`` (rather than around the call to
        # ``StreamingResponse``) because ``current_task()`` here is the task
        # actually iterating the stream — that's what we want to cancel.
        task = asyncio.current_task()
        if task is not None:
            _active_runs[run_id] = task

        # Cost-cap check happens *before* graph construction so we don't pay
        # for compiling a doomed run. The asyncpg pool is wired by the FastAPI
        # lifespan; if it's missing (unit tests, dev without DB), skip the
        # check — degrades open rather than refusing every run. Same for
        # missing ``x-user-id`` (we can't sum-by-user without one). On cap
        # exceeded we still emit ``run-start`` first so the wire stream's
        # event taxonomy is well-formed (the client expects run-start as the
        # opener); then ``error``; then the ``finally`` block emits run-end.
        settings = get_settings()
        pool = getattr(request.app.state, "pg_pool", None)
        if pool is not None and x_user_id:
            try:
                async with pool.acquire() as conn:
                    await assert_under_daily_cap(
                        conn, x_user_id, settings.AGENTS_DAILY_COST_USD_CAP
                    )
            except DailyCapExceeded as e:
                yield (
                    json.dumps(
                        {
                            "type": "run-start",
                            "run_id": run_id,
                            "symbol": body.symbol,
                            "config": {
                                "max_debate_rounds": body.max_debate_rounds,
                                "deep_thinking": body.deep_thinking,
                            },
                        }
                    )
                    + "\n"
                ).encode()
                yield (
                    json.dumps({"type": "error", "message": str(e)}) + "\n"
                ).encode()
                _active_runs.pop(run_id, None)
                yield (
                    json.dumps(
                        {
                            "type": "run-end",
                            "run_id": run_id,
                            "tokens_in": 0,
                            "tokens_out": 0,
                            "cost_usd": 0.0,
                        }
                    )
                    + "\n"
                ).encode()
                return

        opend = getattr(request.app.state, "opend_client", None)
        checkpointer = getattr(request.app.state, "checkpointer", None)
        graph = graph_mod.build_graph(
            opend,
            max_debate_rounds=body.max_debate_rounds,
            deep_thinking=body.deep_thinking,
            checkpointer=checkpointer,
        )
        memory = await _recall_memory(request, x_user_id, body.symbol)
        config = {
            "max_debate_rounds": body.max_debate_rounds,
            "deep_thinking": body.deep_thinking,
            # ``graph`` may be an opaque test double; only real
            # TradingAgentsGraph instances expose ``.config``.
            "models": getattr(getattr(graph, "config", None), "llm_provider", None),
        }
        try:
            async for event in translate_chunks(
                graph_mod.run_graph(
                    graph,
                    body.symbol,
                    trade_date,
                    body.max_debate_rounds,
                    body.deep_thinking,
                    memory=memory,
                    run_id=run_id,
                ),
                run_id=run_id,
                symbol=body.symbol,
                config=config,
            ):
                # request.is_disconnected exists on FastAPI's Request and is
                # cheap to call between events; saves us continuing a paid run
                # after the client gives up.
                if await request.is_disconnected():
                    return
                yield (json.dumps(event) + "\n").encode()
        except DailyCapExceeded as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        except asyncio.CancelledError:
            yield (
                json.dumps({"type": "error", "message": "cancelled"}) + "\n"
            ).encode()
            raise
        except Exception as e:  # noqa: BLE001  # surface any error to the client as an event
            logger.exception("agents run failed: %s", e)
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            _active_runs.pop(run_id, None)
            yield (
                json.dumps(
                    {
                        "type": "run-end",
                        "run_id": run_id,
                        "tokens_in": 0,
                        "tokens_out": 0,
                        "cost_usd": 0.0,
                    }
                )
                + "\n"
            ).encode()

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@router.post("/reflect")
async def trigger_reflect(
    request: Request,
    authorization: str | None = Header(default=None),
    horizon_days: int = 7,
) -> dict[str, int]:
    """Run the nightly reflection pass.

    Iterates pending ``agent_decisions`` rows older than ``horizon_days``,
    computes alpha vs SPY, asks the quick LLM for a lesson, and inserts a
    paired ``agent_reflections`` row. The agents-cron container hits this
    once a day; nothing about it is per-user, so no user header is needed
    (just the internal bearer).
    """
    _check_bearer(authorization)
    pool = getattr(request.app.state, "pg_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="db not ready")
    opend = getattr(request.app.state, "opend_client", None)
    n = await reflection_mod.reflect_pending(pool, opend, horizon_days=horizon_days)
    return {"reflected": n}


@router.delete("/run/{run_id}")
async def cancel_run(
    run_id: str,
    authorization: str | None = Header(default=None),
) -> dict[str, bool]:
    """Cancel an in-flight run by id.

    Returns ``{ok: True, cancelled: True}`` if the task was found and
    cancellation was issued, or ``{ok: True, cancelled: False}`` if the run
    isn't tracked here (already finished, ran on another worker, or never
    existed). The web layer is responsible for reflecting state in the DB
    (it already updates ``agent_runs.status`` to ``'cancelled'``).
    """
    _check_bearer(authorization)
    task = _active_runs.pop(run_id, None)
    if task is not None and not task.done():
        task.cancel()
        return {"ok": True, "cancelled": True}
    return {"ok": True, "cancelled": False}


async def _one(payload: dict) -> AsyncIterator[dict]:
    """Wrap a single normalized chunk as an async iterator for translate_chunks."""
    yield payload


@router.post("/run/{run_id}/resume")
async def resume_run(
    run_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    """Resume a previously-failed/cancelled run from its last checkpoint.

    LangGraph's resume contract: ``astream(None, config={...thread_id: id})``
    means "continue from the latest checkpoint for this thread". If no
    checkpoint exists for ``run_id`` (e.g. the original run failed before
    LangGraph wrote its first checkpoint, or the saver isn't wired),
    LangGraph treats the input as an empty state and the graph effectively
    no-ops. That's acceptable for v1 — the UI surfaces it as a quick
    "complete" with no new events.
    """
    _check_bearer(authorization)
    pool = getattr(request.app.state, "pg_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail="db not ready")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT symbol, trade_date, config FROM agent_runs WHERE id = $1",
            run_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="run not found")

    symbol = row["symbol"]
    cfg = row["config"] or {}
    if isinstance(cfg, str):
        # asyncpg returns ``jsonb`` columns as strings unless you register a
        # codec; agent_runs.config is jsonb, so harden against either.
        try:
            cfg = json.loads(cfg)
        except json.JSONDecodeError:
            cfg = {}

    async def _stream() -> AsyncIterator[bytes]:
        task = asyncio.current_task()
        if task is not None:
            _active_runs[run_id] = task
        opend = getattr(request.app.state, "opend_client", None)
        checkpointer = getattr(request.app.state, "checkpointer", None)
        graph = graph_mod.build_graph(
            opend,
            max_debate_rounds=int(cfg.get("max_debate_rounds", 1)),
            deep_thinking=bool(cfg.get("deep_thinking", True)),
            checkpointer=checkpointer,
        )
        # ``run-start`` is emitted by translate_chunks — for resume we drop
        # it so the client can keep its existing event stream context. The
        # final ``run-end`` is appended in the finally-block as on a fresh
        # run.
        try:
            async for chunk in graph.graph.astream(
                None,
                config={"configurable": {"thread_id": run_id}},
                stream_mode="values",
            ):
                payload = {
                    "metadata": {"langgraph_node": None, "node_finished": False},
                    "values": chunk if isinstance(chunk, dict) else {},
                }
                async for ev in translate_chunks(
                    _one(payload),
                    run_id=run_id,
                    symbol=symbol,
                    config=cfg,
                ):
                    if ev.get("type") == "run-start":
                        continue
                    if await request.is_disconnected():
                        return
                    yield (json.dumps(ev) + "\n").encode()
        except asyncio.CancelledError:
            yield (
                json.dumps({"type": "error", "message": "cancelled"}) + "\n"
            ).encode()
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("agents resume failed: %s", e)
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            _active_runs.pop(run_id, None)
            yield (
                json.dumps(
                    {
                        "type": "run-end",
                        "run_id": run_id,
                        "tokens_in": 0,
                        "tokens_out": 0,
                        "cost_usd": 0.0,
                    }
                )
                + "\n"
            ).encode()

    return StreamingResponse(_stream(), media_type="application/x-ndjson")
