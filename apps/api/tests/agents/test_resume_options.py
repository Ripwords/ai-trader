"""A resumed run must rebuild the graph with the options it started with."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient

from tests.agents.test_router_sync import _FakePool

STORED_CONFIG = {
    "company_name": "NVIDIA Corporation",
    "max_debate_rounds": 2,
    "max_risk_discuss_rounds": 3,
    "deep_thinking": False,
    "reasoning_effort": "high",
    "response_language": "ja-JP",
    "selected_analysts": ["market", "news"],
}


class _RowPool(_FakePool):
    def __init__(self, config: Any) -> None:
        super().__init__()
        self._config = config
        self._conn.fetchrow = self._fetchrow  # type: ignore[attr-defined]

    async def _fetchrow(self, query: str, *args: Any) -> dict[str, Any]:
        return {"symbol": "NVDA", "trade_date": date(2026, 1, 5), "config": self._config}


async def _resume(monkeypatch: pytest.MonkeyPatch, fake_build: Any, config: Any) -> list[dict]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(graph_mod, "build_graph_locked", fake_build)
    app = create_app()
    app.state.pg_pool = _RowPool(config)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run/run-1/resume", headers={"authorization": "Bearer test-bearer"},
        ) as r:
            assert r.status_code == 200
            return [json.loads(line) async for line in r.aiter_lines() if line.strip()]


class _Compiled:
    async def astream(self, *_a: Any, **_kw: Any):
        yield {"decision": {"rating": "hold", "confidence": 50, "rationale": "resumed"}}


class _Graph:
    graph = _Compiled()


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [STORED_CONFIG, json.dumps(STORED_CONFIG)])
async def test_resume_rebuilds_the_graph_with_stored_options(
    monkeypatch: pytest.MonkeyPatch, stored: Any
) -> None:
    seen: dict[str, Any] = {}

    async def fake_build(_opend: Any, **kwargs: Any) -> _Graph:
        seen.update(kwargs)
        return _Graph()

    lines = await _resume(monkeypatch, fake_build, stored)

    assert {k: seen[k] for k in STORED_CONFIG} == STORED_CONFIG
    assert lines[-1]["type"] == "run-end"


@pytest.mark.asyncio
async def test_resume_graph_build_failure_ends_with_error_and_run_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_build(*_a: Any, **_kw: Any) -> _Graph:
        raise RuntimeError("no provider configured")

    lines = await _resume(monkeypatch, fake_build, {})

    assert [e["type"] for e in lines] == ["error", "run-end"]
    assert "no provider configured" in lines[0]["message"]
