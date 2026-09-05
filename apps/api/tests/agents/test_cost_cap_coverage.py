"""The daily cost cap must cover every path that spends: /agents/run was
checked, /agents/backtest and /agents/run/{id}/resume were not."""

from __future__ import annotations

import json
from datetime import date

import pytest
from httpx import ASGITransport, AsyncClient

from app.services.agents import backtest as backtest_mod
from app.services.agents.cost_cap import DailyCapExceeded
from tests.agents.test_router_sync import _FakePool


@pytest.mark.asyncio
async def test_backtest_checks_the_cap_before_every_pair(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.agents import graph as graph_mod

    built = 0

    async def fake_build(*_a, **_kw):
        nonlocal built
        built += 1
        raise RuntimeError("stop before running the graph")

    monkeypatch.setattr(graph_mod, "build_graph_locked", fake_build)

    checks = 0

    async def cap_check() -> None:
        nonlocal checks
        checks += 1
        if checks >= 2:
            raise DailyCapExceeded(spent_usd=5.0, cap_usd=5.0)

    pairs = [backtest_mod.BacktestPair(symbol=s, trade_date=date(2026, 1, 5)) for s in ("A", "B", "C")]
    agg = await backtest_mod.run_backtest(pairs, opend=None, cap_check=cap_check)

    assert checks == 2
    assert built == 1, "only the first pair may reach the graph once the cap trips"
    assert agg.n_runs == 3
    assert [r.error is not None for r in agg.runs] == [True, True, True]
    assert all("daily cap exceeded" in (r.error or "") for r in agg.runs[1:])


@pytest.mark.asyncio
async def test_backtest_route_refuses_without_a_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.settings import get_settings

    get_settings.cache_clear()
    app = create_app()
    app.state.pg_pool = None
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post(
            "/agents/backtest",
            json={"pairs": [{"symbol": "NVDA", "trade_date": "2026-01-05"}]},
            headers={"authorization": "Bearer test-bearer"},
        )
    assert r.status_code == 503
    assert "cost cap" in r.json()["detail"]


@pytest.mark.asyncio
async def test_resume_aborts_when_daily_cap_exceeded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("AGENTS_DAILY_COST_USD_CAP", "5.00")
    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def fake_build(*_a, **_kw):
        raise AssertionError("build_graph_locked must not run when the cap is exceeded")

    monkeypatch.setattr(graph_mod, "build_graph_locked", fake_build)

    class _RowPool(_FakePool):
        def __init__(self) -> None:
            super().__init__(spent=5.50)
            self._conn.fetchrow = self._fetchrow  # type: ignore[attr-defined]

        @staticmethod
        async def _fetchrow(query: str, *args):
            return {"symbol": "NVDA", "trade_date": date(2026, 1, 5), "config": {}}

    app = create_app()
    app.state.pg_pool = _RowPool()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run/run-1/resume", headers={"authorization": "Bearer test-bearer"},
        ) as r:
            assert r.status_code == 200
            lines = [json.loads(line) async for line in r.aiter_lines() if line.strip()]

    types = [e["type"] for e in lines]
    assert types == ["error", "run-end"]
    assert "daily cap exceeded" in lines[0]["message"]
