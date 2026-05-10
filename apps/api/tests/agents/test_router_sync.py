"""Tests for POST /agents/run.

Both ``build_graph`` and ``run_graph`` are monkey-patched so we never construct
a real LangGraph DAG (which would require live LLM keys + moomoo OpenD).
"""

from __future__ import annotations

import json
import os

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.mark.asyncio
async def test_unauthorized() -> None:
    from app.main import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/agents/run", json={"symbol": "NVDA"})
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_streams_canned_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")

    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def fake_run_graph(
        graph,
        symbol: str,
        trade_date,
        max_debate_rounds: int,
        deep_thinking: bool,
        memory: list[dict] | None = None,
        memory_by_role: dict[str, list[dict]] | None = None,
        run_id: str | None = None,
        usage=None,
    ):
        # ``memory`` / ``memory_by_role`` / ``run_id`` / ``usage`` are accepted
        # for signature compatibility with the real ``run_graph``; the
        # canned-event test doesn't exercise them.
        del memory, memory_by_role, run_id, usage
        yield {
            "metadata": {"langgraph_node": "trader", "node_finished": True},
            "values": {
                "decision": {
                    "rating": "buy",
                    "confidence": 70,
                    "rationale": "ok",
                }
            },
        }

    def fake_build_graph(opend_client, **kwargs):
        return object()

    monkeypatch.setattr(graph_mod, "run_graph", fake_run_graph)
    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    headers = {"authorization": f"Bearer {os.environ['INTERNAL_BEARER']}"}
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA"}, headers=headers
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]

    assert lines[0]["type"] == "run-start"
    assert any(e["type"] == "decision" for e in lines)
    assert lines[-1]["type"] == "run-end"


@pytest.mark.asyncio
async def test_emits_error_event_on_run_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")

    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def boom(*_a, **_kw):
        raise RuntimeError("graph blew up")
        yield  # pragma: no cover  # makes it an async generator

    def fake_build_graph(opend_client, **kwargs):
        return object()

    monkeypatch.setattr(graph_mod, "run_graph", boom)
    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    headers = {"authorization": "Bearer test-bearer"}
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA"}, headers=headers
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]

    assert any(e["type"] == "error" and "graph blew up" in e["message"] for e in lines)
    assert lines[-1]["type"] == "run-end"


@pytest.mark.asyncio
async def test_cancel_unknown_run_returns_ok_false(monkeypatch: pytest.MonkeyPatch) -> None:
    """DELETE /agents/run/{id} returns ``cancelled=False`` for unknown ids.

    The cancellation registry is process-local (an in-memory dict on the
    router), so an unknown run id is the *normal* state for a fresh ASGI
    instance — no error, just a falsy ``cancelled`` flag.
    """
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.settings import get_settings

    get_settings.cache_clear()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.delete(
            "/agents/run/00000000-0000-0000-0000-000000000999", headers=headers
        )
        assert r.status_code == 200
        assert r.json() == {"ok": True, "cancelled": False}


@pytest.mark.asyncio
async def test_resume_unauthorized() -> None:
    """POST /agents/run/{id}/resume requires the internal bearer."""
    from app.main import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/agents/run/00000000-0000-0000-0000-000000000001/resume")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_resume_returns_503_when_db_pool_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without an asyncpg pool, resume can't load the original row -> 503.

    Lifespan only attaches ``app.state.pg_pool`` when ``DATABASE_URL`` is set;
    in unit tests it isn't, so the resume handler short-circuits.
    """
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.settings import get_settings

    get_settings.cache_clear()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post(
            "/agents/run/00000000-0000-0000-0000-000000000001/resume",
            headers=headers,
        )
        assert r.status_code == 503


@pytest.mark.asyncio
async def test_run_aborts_when_daily_cap_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``assert_under_daily_cap`` raises, the run never reaches the graph.

    The router pulls a connection from ``app.state.pg_pool`` and calls
    ``assert_under_daily_cap`` *before* invoking ``run_graph``. We stub the
    pool with a fake whose acquired connection's ``fetchval`` returns a value
    above the cap, then assert the response stream is exactly run-start /
    error / run-end (no node-start, no decision).
    """
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")
    monkeypatch.setenv("AGENTS_DAILY_COST_USD_CAP", "5.00")

    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def boom_run(*_a, **_kw):
        raise AssertionError("run_graph must not be called when cap is exceeded")
        yield  # pragma: no cover  # makes it an async generator

    def fake_build_graph(opend_client, **kwargs):
        raise AssertionError("build_graph must not be called when cap is exceeded")

    monkeypatch.setattr(graph_mod, "run_graph", boom_run)
    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    class FakeConn:
        async def fetchval(self, query: str, *args) -> float:
            return 5.50  # over the 5.00 cap

    class FakeAcquireCtx:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *a) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquireCtx:
            return FakeAcquireCtx()

    app = create_app()
    app.state.pg_pool = FakePool()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST",
            "/agents/run",
            json={"symbol": "NVDA"},
            headers={**headers, "x-user-id": "00000000-0000-0000-0000-0000000000aa"},
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]

    types = [e["type"] for e in lines]
    assert types[0] == "run-start"
    assert types[-1] == "run-end"
    assert any(
        e["type"] == "error" and "daily cap exceeded" in e["message"] for e in lines
    )
    # No node-start / decision should have been emitted.
    assert not any(e["type"] in ("node-start", "decision") for e in lines)


@pytest.mark.asyncio
async def test_run_proceeds_when_under_daily_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Sanity-check: when ``fetchval`` is under cap, the graph runs normally."""
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")
    monkeypatch.setenv("AGENTS_DAILY_COST_USD_CAP", "5.00")

    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def fake_run_graph(*_a, **_kw):
        yield {
            "metadata": {"langgraph_node": "trader", "node_finished": True},
            "values": {
                "decision": {
                    "rating": "buy",
                    "confidence": 70,
                    "rationale": "ok",
                }
            },
        }

    def fake_build_graph(opend_client, **kwargs):
        return object()

    monkeypatch.setattr(graph_mod, "run_graph", fake_run_graph)
    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    class FakeConn:
        async def fetchval(self, query: str, *args) -> float:
            return 0.50

    class FakeAcquireCtx:
        async def __aenter__(self) -> FakeConn:
            return FakeConn()

        async def __aexit__(self, *a) -> None:
            return None

    class FakePool:
        def acquire(self) -> FakeAcquireCtx:
            return FakeAcquireCtx()

    app = create_app()
    app.state.pg_pool = FakePool()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST",
            "/agents/run",
            json={"symbol": "NVDA"},
            headers={**headers, "x-user-id": "00000000-0000-0000-0000-0000000000bb"},
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]

    assert any(e["type"] == "decision" for e in lines)
    assert lines[-1]["type"] == "run-end"


@pytest.mark.asyncio
async def test_run_end_carries_accumulated_token_totals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``run-end`` reports the tokens the UsageAccumulator collected during the run.

    We intercept ``run_graph`` and feed the accumulator (passed via the
    ``usage`` kwarg) two synthetic LLM-end events. The router should then
    surface those totals on the trailing ``run-end`` event and price the run
    against the configured deep model.
    """
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")

    from langchain_core.outputs import LLMResult

    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def fake_run_graph(
        graph,
        symbol: str,
        trade_date,
        max_debate_rounds: int,
        deep_thinking: bool,
        memory: list[dict] | None = None,
        memory_by_role: dict[str, list[dict]] | None = None,
        run_id: str | None = None,
        usage=None,
    ):
        del memory, memory_by_role, run_id, max_debate_rounds, deep_thinking
        del graph, symbol, trade_date
        # Simulate two LLM calls' worth of usage flowing through the callback.
        if usage is not None:
            await usage.on_llm_end(
                LLMResult(
                    generations=[[]],
                    llm_output={
                        "token_usage": {
                            "prompt_tokens": 1000,
                            "completion_tokens": 250,
                        }
                    },
                )
            )
            await usage.on_llm_end(
                LLMResult(
                    generations=[[]],
                    llm_output={
                        "token_usage": {
                            "prompt_tokens": 500,
                            "completion_tokens": 100,
                        }
                    },
                )
            )
        yield {
            "metadata": {"langgraph_node": "trader", "node_finished": True},
            "values": {
                "decision": {
                    "rating": "buy",
                    "confidence": 70,
                    "rationale": "ok",
                }
            },
        }

    def fake_build_graph(opend_client, **kwargs):
        return object()

    monkeypatch.setattr(graph_mod, "run_graph", fake_run_graph)
    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    headers = {"authorization": "Bearer test-bearer"}
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA"}, headers=headers
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]

    end = lines[-1]
    assert end["type"] == "run-end"
    assert end["tokens_in"] == 1500
    assert end["tokens_out"] == 350
    # claude-sonnet-4-6 is in the pricing table; cost should be > 0.
    # input: 1500 * 3 / 1_000_000 = 0.0045; output: 350 * 15 / 1_000_000 = 0.00525
    # total ~= 0.00975
    assert end["cost_usd"] == pytest.approx(0.00975, rel=1e-6)


@pytest.mark.smoke
@pytest.mark.skipif(
    os.environ.get("RUN_SMOKE") != "1",
    reason="Real-LLM smoke test; set RUN_SMOKE=1 to enable",
)
@pytest.mark.asyncio
async def test_real_run_streams_decision() -> None:
    """End-to-end smoke test against a live LLM + moomoo OpenD.

    Skipped by default. Requires: ``RUN_SMOKE=1``, ``ANTHROPIC_API_KEY`` (or
    equivalent for the configured provider), and a reachable OpenD on the
    host configured via ``OPEND_HOST``/``OPEND_PORT``.
    """
    from app.main import create_app

    headers = {"authorization": f"Bearer {os.environ['INTERNAL_BEARER']}"}
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t", timeout=300.0) as c:
        async with c.stream(
            "POST",
            "/agents/run",
            json={"symbol": "NVDA", "max_debate_rounds": 1, "deep_thinking": False},
            headers=headers,
        ) as r:
            assert r.status_code == 200
            lines = [
                json.loads(line) async for line in r.aiter_lines() if line.strip()
            ]
    assert lines[0]["type"] == "run-start"
    assert lines[-1]["type"] == "run-end"
