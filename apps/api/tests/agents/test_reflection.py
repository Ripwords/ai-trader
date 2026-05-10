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


def _bars(start: date, closes: list[float]) -> list[dict]:
    """Build a list of date-keyed bar dicts for the date-slicing tests."""
    from datetime import timedelta

    return [
        {
            "time_key": (start + timedelta(days=i)).isoformat(),
            "close": close,
        }
        for i, close in enumerate(closes)
    ]


@pytest.mark.asyncio
async def test_buy_correct_when_outperforms_spy() -> None:
    """Decision on 2026-05-01, 7-day horizon: bars cover that window."""
    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        # Return enough history to cover the trade_date through trade_date + horizon.
        if ticker == "NVDA":
            return _bars(date(2026, 5, 1), [100, 101, 102, 103, 104, 104.5, 105, 105])
        return _bars(date(2026, 5, 1), [100, 100.2, 100.4, 100.6, 100.8, 100.9, 101, 101])

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
            return _bars(date(2026, 5, 1), [100, 99, 98, 97, 96.5, 96, 95.5, 95])
        return _bars(date(2026, 5, 1), [100, 100.2, 100.4, 100.6, 100.7, 100.8, 100.9, 101])

    opend.get_kline.side_effect = kline
    res = await compute_realized_return(
        opend=opend,
        symbol="NVDA",
        trade_date=date(2026, 5, 1),
        rating="sell",
        horizon_days=7,
    )
    assert res.outcome == "correct"


@pytest.mark.asyncio
async def test_uses_trade_date_window_not_latest_bars() -> None:
    """Decision is 30 days old, horizon 7 — alpha is computed from days 30 -> 23 ago.

    The OpenD client returns daily bars from before the trade date through
    today; we must slice the window by ``time_key``, not just take the
    leading or trailing N bars. Earlier bars (before trade_date) and later
    bars (after trade_date + horizon) MUST NOT influence the result.
    """
    from datetime import timedelta

    today = date(2026, 5, 10)
    trade_date = today - timedelta(days=30)  # 2026-04-10
    horizon_days = 7

    # Build a bar series where the window [trade_date, trade_date + 7 days]
    # has sym 100 -> 110 (+10%) and SPY 100 -> 102 (+2%) → alpha +8.
    # Outside that window we put junk values that would skew the result if
    # the slicer looked at the wrong bars.
    def series(start_date: date, num_days: int, junk: float, window_pattern: list[float]) -> list[dict]:
        from datetime import timedelta

        out: list[dict] = []
        window_start = trade_date
        window_end = trade_date + timedelta(days=horizon_days)
        for i in range(num_days):
            d = start_date + timedelta(days=i)
            if window_start <= d <= window_end:
                idx = (d - window_start).days
                idx = min(idx, len(window_pattern) - 1)
                close = window_pattern[idx]
            else:
                close = junk
            out.append({"time_key": d.isoformat(), "close": close})
        return out

    sym_window = [100, 102, 104, 106, 108, 109, 109.5, 110]
    spy_window = [100, 100.3, 100.6, 101, 101.3, 101.6, 101.8, 102]

    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        # OpenD returns ``num`` bars; we ask for enough to cover the window.
        # We start a few days before trade_date so the leading "junk" gets
        # exercised.
        from datetime import timedelta

        start = trade_date - timedelta(days=5)
        if ticker == "NVDA":
            return series(start, num, junk=999.0, window_pattern=sym_window)
        return series(start, num, junk=999.0, window_pattern=spy_window)

    opend.get_kline.side_effect = kline
    res = await compute_realized_return(
        opend=opend,
        symbol="NVDA",
        trade_date=trade_date,
        rating="buy",
        horizon_days=horizon_days,
    )
    assert res.realized_return == pytest.approx(10.0, rel=0.01)
    assert res.benchmark_return == pytest.approx(2.0, rel=0.01)
    assert res.alpha == pytest.approx(8.0, rel=0.01)


@pytest.mark.asyncio
async def test_compute_raises_when_history_too_short_for_trade_date() -> None:
    """If the bars don't cover the trade_date, raise so the caller logs a clear error."""
    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        # Return bars only for 2026-05-08 onwards; trade_date is 2026-04-10.
        return _bars(date(2026, 5, 8), [100, 101, 102])

    opend.get_kline.side_effect = kline
    with pytest.raises(ValueError, match="insufficient history"):
        await compute_realized_return(
            opend=opend,
            symbol="NVDA",
            trade_date=date(2026, 4, 10),
            rating="buy",
            horizon_days=7,
        )


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
        # The decision was inserted 10 days ago with horizon=7; we need bars
        # that cover trade_date (today - 10 days) through trade_date + 7d.
        from datetime import date as _d
        from datetime import timedelta

        td = _d.today() - timedelta(days=10)
        if ticker == "NVDA":
            closes = [100, 102, 104, 106, 108, 109, 109.5, 110]
        else:
            closes = [100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102]
        return [
            {"time_key": (td + timedelta(days=i)).isoformat(), "close": closes[i]}
            for i in range(len(closes))
        ]

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
