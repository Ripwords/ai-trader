"""Tests for the nightly reflection job.

The reflection job processes ``agent_decisions`` rows older than
``horizon_days`` that don't yet have a paired ``agent_reflections`` row,
computes alpha vs SPY, asks the quick LLM for a 2-3 sentence lesson, and
persists the result. ``compute_realized_return`` is the pure-function core
and is the easiest to unit test; the orchestrator (`reflect_pending`) is
covered against a real Postgres testcontainer with the LLM step stubbed.
"""

from __future__ import annotations

from datetime import date
from unittest.mock import AsyncMock

import pytest

from app.services.agents.reflection import (
    RealizedReturn,
    _classify_outcome,
    compute_realized_return,
)


@pytest.mark.asyncio
async def test_buy_correct_when_outperforms_spy() -> None:
    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        if ticker == "NVDA":
            return [{"close": 100}, {"close": 105}]
        return [{"close": 100}, {"close": 101}]

    opend.get_kline.side_effect = kline
    res = await compute_realized_return(
        opend=opend,
        symbol="NVDA",
        trade_date=date(2026, 5, 1),
        rating="buy",
        horizon_days=7,
    )
    assert res.realized_return == pytest.approx(5.0, rel=0.01)
    assert res.benchmark_return == pytest.approx(1.0, rel=0.01)
    assert res.alpha == pytest.approx(4.0, rel=0.01)
    assert res.outcome == "correct"


@pytest.mark.asyncio
async def test_sell_correct_when_symbol_underperforms() -> None:
    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        if ticker == "NVDA":
            return [{"close": 100}, {"close": 95}]
        return [{"close": 100}, {"close": 101}]

    opend.get_kline.side_effect = kline
    res = await compute_realized_return(
        opend=opend,
        symbol="NVDA",
        trade_date=date(2026, 5, 1),
        rating="sell",
        horizon_days=7,
    )
    assert res.outcome == "correct"


def test_classify_neutral_when_alpha_small() -> None:
    assert _classify_outcome("buy", 0.3) == "neutral"


def test_classify_wrong_when_buy_alpha_negative() -> None:
    assert _classify_outcome("buy", -1.5) == "wrong"


def test_classify_correct_hold_when_alpha_small_for_hold() -> None:
    assert _classify_outcome("hold", 0.3) == "correct"


@pytest.mark.asyncio
async def test_compute_realized_return_handles_missing_bars() -> None:
    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        return []

    opend.get_kline.side_effect = kline
    with pytest.raises(Exception):
        await compute_realized_return(
            opend=opend,
            symbol="NVDA",
            trade_date=date(2026, 5, 1),
            rating="buy",
            horizon_days=7,
        )


@pytest.mark.asyncio
async def test_reflect_pending_writes_rows(
    pg_pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Orchestrator persists one ``agent_reflections`` row per pending decision.

    ``write_reflection_text`` is stubbed (the real one calls a remote LLM).
    The decision row is back-dated past ``horizon_days`` so it qualifies as
    pending.
    """
    from app.services.agents import reflection as reflection_mod

    user_id = "00000000-0000-0000-0000-000000000010"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'reflectee') "
            "ON CONFLICT DO NOTHING",
            user_id,
        )
        run_id = await conn.fetchval(
            "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status) "
            "VALUES($1, 'NVDA', current_date - 10, '{}'::jsonb, 'complete') "
            "RETURNING id",
            user_id,
        )
        decision_id = await conn.fetchval(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale, "
            " created_at) "
            "VALUES($1, $2, 'NVDA', current_date - 10, 'buy', 70, 'r', "
            " now() - interval '10 days') RETURNING id",
            run_id,
            user_id,
        )

    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        if ticker == "NVDA":
            return [{"close": 100}, {"close": 110}]
        return [{"close": 100}, {"close": 102}]

    opend.get_kline.side_effect = kline

    async def fake_write(summary: str, realized: RealizedReturn) -> str:
        return f"lesson: {realized.outcome} {realized.alpha:+.2f}%"

    monkeypatch.setattr(reflection_mod, "write_reflection_text", fake_write)

    n = await reflection_mod.reflect_pending(pg_pool, opend, horizon_days=7)
    assert n == 1

    async with pg_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT outcome, alpha::float AS alpha, text FROM agent_reflections "
            "WHERE decision_id = $1",
            decision_id,
        )
    assert row is not None
    assert row["outcome"] == "correct"
    assert row["alpha"] == pytest.approx(8.0, rel=0.01)
    assert row["text"].startswith("lesson:")


@pytest.mark.asyncio
async def test_reflect_pending_skips_already_reflected(
    pg_pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A decision with an existing reflection row is left alone."""
    from app.services.agents import reflection as reflection_mod

    user_id = "00000000-0000-0000-0000-000000000011"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'already-reflected') "
            "ON CONFLICT DO NOTHING",
            user_id,
        )
        run_id = await conn.fetchval(
            "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status) "
            "VALUES($1, 'TSLA', current_date - 10, '{}'::jsonb, 'complete') "
            "RETURNING id",
            user_id,
        )
        decision_id = await conn.fetchval(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale, "
            " created_at) "
            "VALUES($1, $2, 'TSLA', current_date - 10, 'buy', 70, 'r', "
            " now() - interval '10 days') RETURNING id",
            run_id,
            user_id,
        )
        await conn.execute(
            "INSERT INTO agent_reflections"
            "(id, decision_id, horizon_days, realized_return, benchmark_return, "
            " alpha, outcome, text) "
            "VALUES(gen_random_uuid(), $1, 7, 0, 0, 0, 'neutral', 'old')",
            decision_id,
        )

    opend = AsyncMock()
    opend.get_kline.side_effect = AssertionError("must not be called")

    async def fake_write(summary: str, realized: RealizedReturn) -> str:
        raise AssertionError("must not be called")

    monkeypatch.setattr(reflection_mod, "write_reflection_text", fake_write)

    n = await reflection_mod.reflect_pending(pg_pool, opend, horizon_days=7)
    assert n == 0


@pytest.mark.asyncio
async def test_reflect_endpoint_returns_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """POST /agents/reflect proxies to ``reflect_pending`` and returns ``{reflected: N}``."""
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")

    from httpx import ASGITransport, AsyncClient

    from app.main import create_app
    from app.services.agents import reflection as reflection_mod
    from app.settings import get_settings

    get_settings.cache_clear()

    async def fake_reflect(pool, opend, *, horizon_days: int = 7) -> int:
        return 3

    monkeypatch.setattr(reflection_mod, "reflect_pending", fake_reflect)

    # The endpoint short-circuits with 503 when no pool is attached, so
    # stub a sentinel pool onto app.state.
    app = create_app()
    app.state.pg_pool = object()
    app.state.opend_client = object()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/agents/reflect", headers=headers)
        assert r.status_code == 200
        assert r.json() == {"reflected": 3}


@pytest.mark.asyncio
async def test_reflect_endpoint_unauthorized() -> None:
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/agents/reflect")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_reflect_endpoint_503_without_pool(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without an asyncpg pool attached, /agents/reflect returns 503."""
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from httpx import ASGITransport, AsyncClient

    from app.main import create_app
    from app.settings import get_settings

    get_settings.cache_clear()

    headers = {"authorization": "Bearer test-bearer"}
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/agents/reflect", headers=headers)
        assert r.status_code == 503
