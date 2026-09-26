"""AGENTS_STUB_RUN_SECONDS swaps the LLM graph for a sleeping stub so the
streaming repro scripts can run without keys or spend."""

from __future__ import annotations

import json

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.agents import graph as graph_mod
from app.services.agents import stub as stub_mod
from tests.agents.test_router_sync import _FakePool


def test_not_installed_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENTS_STUB_RUN_SECONDS", raising=False)
    real = graph_mod.run_graph
    assert stub_mod.install_stub_if_enabled() is False
    assert graph_mod.run_graph is real


@pytest.mark.asyncio
async def test_stubbed_run_streams_a_decision(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("AGENTS_STUB_RUN_SECONDS", "0.01")
    monkeypatch.setattr(graph_mod, "run_graph", graph_mod.run_graph)
    monkeypatch.setattr(graph_mod, "build_graph", graph_mod.build_graph)
    from app.main import create_app
    from app.settings import get_settings

    get_settings.cache_clear()
    assert stub_mod.install_stub_if_enabled() is True

    app = create_app()
    app.state.pg_pool = _FakePool()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json={"symbol": "NVDA", "company_name": "NVIDIA"},
            headers={"authorization": "Bearer test-bearer"},
        ) as r:
            lines = [json.loads(line) async for line in r.aiter_lines() if line.strip()]

    kinds = [e["type"] for e in lines]
    assert "node-start" in kinds
    assert "decision" in kinds
    assert kinds[-1] == "run-end"
