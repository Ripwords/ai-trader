"""Heartbeats keep the api -> web NDJSON stream from going idle while a
graph node thinks, and never reorder or swallow the real events."""

from __future__ import annotations

import asyncio
import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.agents.heartbeat import HEARTBEAT, with_heartbeats
from tests.agents.test_router_sync import _FakePool


async def _slow(items: list[str], delay: float):
    for item in items:
        await asyncio.sleep(delay)
        yield item


@pytest.mark.asyncio
async def test_yields_heartbeats_during_gaps_and_keeps_order() -> None:
    out = [ev async for ev in with_heartbeats(_slow(["a", "b"], 0.12), interval=0.05)]
    real = [ev for ev in out if ev is not HEARTBEAT]
    assert real == ["a", "b"]
    assert out.count(HEARTBEAT) >= 2
    assert out[0] is HEARTBEAT


@pytest.mark.asyncio
async def test_no_heartbeat_when_items_arrive_fast() -> None:
    out = [ev async for ev in with_heartbeats(_slow(["a", "b", "c"], 0), interval=1.0)]
    assert out == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_propagates_source_exception() -> None:
    async def boom():
        yield "a"
        raise RuntimeError("node blew up")

    seen: list[object] = []
    with pytest.raises(RuntimeError, match="node blew up"):
        async for ev in with_heartbeats(boom(), interval=1.0):
            seen.append(ev)
    assert seen == ["a"]


@pytest.mark.asyncio
async def test_cancelling_consumer_cancels_the_source() -> None:
    source_cancelled = asyncio.Event()

    async def forever():
        try:
            yield "a"
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            source_cancelled.set()
            raise

    async def consume() -> None:
        async for _ in with_heartbeats(forever(), interval=0.01):
            pass

    task = asyncio.create_task(consume())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(source_cancelled.wait(), timeout=1.0)


@pytest.mark.asyncio
async def test_run_stream_emits_heartbeat_lines_while_a_node_is_slow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.routers import agents as agents_router
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(agents_router, "HEARTBEAT_INTERVAL_S", 0.05)

    async def slow_run_graph(*_a, **_kw):
        await asyncio.sleep(0.2)
        yield {
            "metadata": {"langgraph_node": "trader", "node_finished": True},
            "values": {"decision": {"rating": "buy", "confidence": 70, "rationale": "ok"}},
        }

    monkeypatch.setattr(graph_mod, "run_graph", slow_run_graph)
    monkeypatch.setattr(graph_mod, "build_graph", lambda opend_client, **kw: object())

    app = create_app()
    app.state.pg_pool = _FakePool()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA"},
            headers={"authorization": "Bearer test-bearer"},
        ) as r:
            lines = [json.loads(line) async for line in r.aiter_lines() if line.strip()]

    kinds = [e["type"] for e in lines]
    assert kinds.count("heartbeat") >= 2
    assert kinds[0] == "run-start"
    assert kinds[-1] == "run-end"
    assert kinds.index("heartbeat") < kinds.index("decision")


@pytest.mark.asyncio
async def test_graph_build_failure_still_ends_with_error_and_run_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    def broken_build(opend_client, **kw):
        raise KeyError("LLM_MODEL")

    monkeypatch.setattr(graph_mod, "build_graph", broken_build)

    app = create_app()
    app.state.pg_pool = _FakePool()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA", "company_name": "NVIDIA"},
            headers={"authorization": "Bearer test-bearer"},
        ) as r:
            lines = [json.loads(line) async for line in r.aiter_lines() if line.strip()]

    kinds = [e["type"] for e in lines]
    assert "error" in kinds
    assert kinds[-1] == "run-end"
