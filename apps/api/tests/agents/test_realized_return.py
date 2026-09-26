"""Tests for ``compute_realized_return`` — alpha vs SPY for a past decision.

The OpenD client is stubbed with date-keyed bars so the trade-date window
slicing and the outcome classifier can be checked without a network.
"""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import AsyncMock

import pytest

from app.services.agents.realized_return import (
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


def test_bar_date_reads_time_key_string() -> None:
    from app.services.agents.realized_return import _bar_date

    assert _bar_date({"time_key": "2026-05-01"}) == date(2026, 5, 1)
    assert _bar_date({"time_key": "2026-05-01 09:30:00"}) == date(2026, 5, 1)


def test_bar_date_falls_back_to_time_field() -> None:
    """Production OpendAdapter's Bar pydantic model exposes ``time`` (datetime),
    not ``time_key``; both must be read."""
    from datetime import datetime

    from app.services.agents.realized_return import _bar_date

    assert _bar_date({"time": datetime(2026, 5, 1, 16, 0)}) == date(2026, 5, 1)
    assert _bar_date({"time": date(2026, 5, 1)}) == date(2026, 5, 1)
    assert _bar_date({"time": "2026-05-01"}) == date(2026, 5, 1)


def test_bar_date_returns_none_for_missing_or_malformed() -> None:
    from app.services.agents.realized_return import _bar_date

    assert _bar_date({}) is None
    assert _bar_date({"time_key": ""}) is None
    assert _bar_date({"time_key": "not-a-date"}) is None
