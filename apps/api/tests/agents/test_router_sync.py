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
    ):
        # ``memory`` is accepted for signature compatibility with the real
        # ``run_graph``; the canned-event test doesn't exercise it.
        del memory
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
