"""Tests for the nightly reflection job.

The reflection job processes ``agent_decisions`` rows older than
``horizon_days`` that don't yet have a paired ``agent_reflections`` row,
computes alpha vs SPY, asks the quick LLM for a 2-3 sentence lesson, and
persists the result. ``compute_realized_return`` is the pure-function core
and is the easiest to unit test; the orchestrator (`reflect_pending`) is
covered against a real Postgres testcontainer with the LLM step stubbed.
"""

from __future__ import annotations

from datetime import date, timedelta
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
    # Exit close of the symbol at the horizon — feeds the valuation-error note.
    assert res.realized_price == pytest.approx(105.0, rel=0.001)


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


def test_format_valuation_note_too_optimistic() -> None:
    from app.services.agents.reflection import _format_valuation_note

    note = _format_valuation_note(
        fair_value=150.0, mos_pct=0.25, realized_price=110.0, horizon_days=7
    )
    assert "fair value 150.00" in note
    assert "MoS 25.0%" in note
    assert "110.00" in note
    assert "too optimistic" in note


def test_format_valuation_note_too_pessimistic() -> None:
    from app.services.agents.reflection import _format_valuation_note

    note = _format_valuation_note(
        fair_value=90.0, mos_pct=-0.1, realized_price=120.0, horizon_days=7
    )
    assert "too pessimistic" in note


def test_format_valuation_note_about_right() -> None:
    from app.services.agents.reflection import _format_valuation_note

    note = _format_valuation_note(
        fair_value=102.0, mos_pct=0.02, realized_price=100.0, horizon_days=7
    )
    assert "about right" in note


def test_format_valuation_note_without_mos() -> None:
    from app.services.agents.reflection import _format_valuation_note

    note = _format_valuation_note(
        fair_value=150.0, mos_pct=None, realized_price=110.0, horizon_days=7
    )
    assert "MoS" not in note
    assert "fair value 150.00" in note


def test_role_reflection_prompt_includes_valuation_note() -> None:
    from app.services.agents.reflection import _role_reflection_prompt

    realized = RealizedReturn(5.0, 1.0, 4.0, "correct", realized_price=105.0)
    prompt = _role_reflection_prompt(
        "RESEARCH JUDGE", "some judge decision", realized,
        valuation_note="valuation called fair value 150.00; ...",
    )
    assert "valuation called fair value 150.00" in prompt
    without = _role_reflection_prompt(
        "RESEARCH JUDGE", "some judge decision", realized, valuation_note=None
    )
    assert "valuation called" not in without


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
    """Orchestrator persists FIVE ``agent_reflections`` rows per pending
    decision — one per role (trader, bull_researcher, bear_researcher,
    invest_judge, risk_manager). Mirrors TradingAgents' Reflector which
    writes a role-specific lesson into each role's FinancialSituationMemory.

    ``_write_role_reflection`` is stubbed (the real one calls a remote LLM).
    The decision row is back-dated past ``horizon_days`` so it qualifies
    as pending; ``agent_runs.final_state`` is populated with role inputs
    so each role gets a non-empty string to reflect on.
    """
    from app.services.agents import reflection as reflection_mod

    user_id = "00000000-0000-0000-0000-000000000010"
    final_state_json = (
        '{"trader_investment_plan":"buy 100 shares",'
        '"investment_debate_state":'
          '{"bull_history":"bull case","bear_history":"bear case","judge_decision":"buy"},'
        '"risk_debate_state":{"judge_decision":"approve"}}'
    )
    trade_date = date.today() - timedelta(days=10)
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'reflectee') "
            "ON CONFLICT DO NOTHING",
            user_id,
        )
        run_id = await conn.fetchval(
            "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status, final_state) "
            "VALUES($1, 'NVDA', $3, '{}'::jsonb, 'complete', $2::jsonb) "
            "RETURNING id",
            user_id, final_state_json, trade_date,
        )
        decision_id = await conn.fetchval(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale, "
            " created_at) "
            "VALUES($1, $2, 'NVDA', $3, 'buy', 70, 'r', "
            " now() - interval '10 days') RETURNING id",
            run_id,
            user_id,
            trade_date,
        )

    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        if ticker == "NVDA":
            closes = [100, 102, 104, 106, 108, 109, 109.5, 110]
        else:
            closes = [100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102]
        return [
            {"time_key": (trade_date + timedelta(days=i)).isoformat(), "close": closes[i]}
            for i in range(len(closes))
        ]

    opend.get_kline.side_effect = kline

    async def fake_role_write(
        role_prefix: str, role_input: str, realized, valuation_note=None
    ) -> str:
        # No valuation_snapshots row exists for NVDA — the note must
        # degrade gracefully to None for every role.
        assert valuation_note is None
        return f"lesson({role_prefix}): {realized.outcome} {realized.alpha:+.2f}%"

    monkeypatch.setattr(reflection_mod, "_write_role_reflection", fake_role_write)

    n = await reflection_mod.reflect_pending(pg_pool, opend, horizon_days=7)
    # Five rows per decision, one per role.
    assert n == 5

    async with pg_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT role, outcome, alpha::float AS alpha, text "
            "FROM agent_reflections WHERE decision_id = $1 ORDER BY role",
            decision_id,
        )
    roles = {r["role"] for r in rows}
    assert roles == {
        "trader", "bull_researcher", "bear_researcher",
        "invest_judge", "risk_manager",
    }
    for r in rows:
        assert r["outcome"] == "correct"
        assert r["alpha"] == pytest.approx(8.0, rel=0.01)
        assert r["text"].startswith("lesson(")


@pytest.mark.asyncio
async def test_reflect_pending_valuation_note_for_judge_roles(
    pg_pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When a valuation_snapshots row exists for the decision's symbol at/
    before the decision time, invest_judge and risk_manager reflections get
    a compact valuation-error note (fair value vs realized price); the
    other roles don't — they never saw the valuation summary at run time.
    """
    from app.services.agents import reflection as reflection_mod

    user_id = "00000000-0000-0000-0000-000000000012"
    final_state_json = (
        '{"trader_investment_plan":"buy 50 shares",'
        '"investment_debate_state":'
          '{"bull_history":"bull case","bear_history":"bear case","judge_decision":"buy"},'
        '"risk_debate_state":{"judge_decision":"approve"}}'
    )
    trade_date = date.today() - timedelta(days=10)
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'val-noted') "
            "ON CONFLICT DO NOTHING",
            user_id,
        )
        run_id = await conn.fetchval(
            "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status, final_state) "
            "VALUES($1, 'AMD', $3, '{}'::jsonb, 'complete', $2::jsonb) "
            "RETURNING id",
            user_id, final_state_json, trade_date,
        )
        await conn.execute(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale, "
            " created_at) "
            "VALUES($1, $2, 'AMD', $3, 'buy', 70, 'r', "
            " now() - interval '10 days')",
            run_id, user_id, trade_date,
        )
        # Snapshot written at run time (just before the decision).
        await conn.execute(
            "INSERT INTO valuation_snapshots"
            "(symbol, source, run_id, fair_value, current_price, "
            " margin_of_safety_pct, data_quality, veto_triggered, result, created_at) "
            "VALUES('AMD', 'agent_run', $1, 150, 100, 0.5, 'full', false, "
            " '{}'::jsonb, now() - interval '10 days 1 hour')",
            run_id,
        )

    opend = AsyncMock()

    async def kline(ticker: str, ktype: str, num: int) -> list[dict]:
        if ticker == "AMD":
            closes = [100, 102, 104, 106, 108, 109, 109.5, 110]
        else:
            closes = [100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102]
        return [
            {"time_key": (trade_date + timedelta(days=i)).isoformat(), "close": closes[i]}
            for i in range(len(closes))
        ]

    opend.get_kline.side_effect = kline

    notes: dict[str, str | None] = {}

    async def fake_role_write(
        role_prefix: str, role_input: str, realized, valuation_note=None
    ) -> str:
        notes[role_prefix] = valuation_note
        return f"lesson({role_prefix})"

    monkeypatch.setattr(reflection_mod, "_write_role_reflection", fake_role_write)

    n = await reflection_mod.reflect_pending(pg_pool, opend, horizon_days=7)
    assert n == 5

    # The two roles that see the valuation summary at run time get the note.
    for prefix in ("RESEARCH JUDGE", "RISK MANAGER"):
        note = notes[prefix]
        assert note is not None
        assert "fair value 150.00" in note
        assert "110.00" in note
        assert "too optimistic" in note
    # The rest reflect without it.
    for prefix in ("TRADER", "BULL RESEARCHER", "BEAR RESEARCHER"):
        assert notes[prefix] is None


@pytest.mark.asyncio
async def test_reflect_pending_skips_already_reflected(
    pg_pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A decision that already has all five role reflections is excluded
    from the pending sweep — _PENDING_SQL filters by reflection count < 5."""
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
        # Pre-fill all five role reflections so the decision is "fully reflected".
        for role in ("trader", "bull_researcher", "bear_researcher", "invest_judge", "risk_manager"):
            await conn.execute(
                "INSERT INTO agent_reflections"
                "(id, decision_id, role, horizon_days, realized_return, "
                " benchmark_return, alpha, outcome, text) "
                "VALUES(gen_random_uuid(), $1, $2, 7, 0, 0, 0, 'neutral', 'old')",
                decision_id, role,
            )

    opend = AsyncMock()
    opend.get_kline.side_effect = AssertionError("must not be called")

    async def fake_role_write(
        role_prefix: str, role_input: str, realized, valuation_note=None
    ) -> str:
        raise AssertionError("must not be called")

    monkeypatch.setattr(reflection_mod, "_write_role_reflection", fake_role_write)

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


def test_bar_date_reads_time_key_string() -> None:
    from app.services.agents.reflection import _bar_date

    assert _bar_date({"time_key": "2026-05-01"}) == date(2026, 5, 1)
    assert _bar_date({"time_key": "2026-05-01 09:30:00"}) == date(2026, 5, 1)


def test_bar_date_falls_back_to_time_field() -> None:
    """Production OpendAdapter's Bar pydantic model exposes ``time`` (datetime),
    not ``time_key``; reflection must read either."""
    from datetime import datetime

    from app.services.agents.reflection import _bar_date

    assert _bar_date({"time": datetime(2026, 5, 1, 16, 0)}) == date(2026, 5, 1)
    assert _bar_date({"time": date(2026, 5, 1)}) == date(2026, 5, 1)
    assert _bar_date({"time": "2026-05-01"}) == date(2026, 5, 1)


def test_bar_date_returns_none_for_missing_or_malformed() -> None:
    from app.services.agents.reflection import _bar_date

    assert _bar_date({}) is None
    assert _bar_date({"time_key": ""}) is None
    assert _bar_date({"time_key": "not-a-date"}) is None


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
