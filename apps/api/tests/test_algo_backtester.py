"""Tests for the bar-walk backtester engine."""

from __future__ import annotations

from datetime import datetime, timedelta

from app.schemas.algo import BacktestResult
from app.schemas.quote import Bar
from app.services.algo.backtester import INITIAL_CASH, run_backtest


def _bars(closes: list[float], opens: list[float] | None = None) -> list[Bar]:
    """Build a list of daily bars from a list of closes (and optional opens)."""
    out: list[Bar] = []
    base = datetime(2026, 1, 1)
    for i, c in enumerate(closes):
        o = opens[i] if opens else c
        out.append(
            Bar(
                time=base + timedelta(days=i),
                open=o,
                high=max(o, c),
                low=min(o, c),
                close=c,
                volume=1_000,
                turnover=1_000.0 * c,
            )
        )
    return out


def test_buy_and_hold_fills_at_next_open() -> None:
    """A strategy that buys on every up-day should fill at the *next* bar's
    open, not at the bar where the signal fired (no look-ahead)."""
    code = (
        "def on_bar(c):\n"
        "    if len(c.bars) >= 2 and c.bars['close'].iloc[-1] > c.bars['close'].iloc[-2]:\n"
        "        c.buy(c.qty)\n"
    )
    # Closes: 100, 101, 102 — two up-days; opens 100, 101.5, 103.
    bars = _bars(closes=[100.0, 101.0, 102.0], opens=[100.0, 101.5, 103.0])
    res = run_backtest(code, bars, qty_per_signal=1)
    assert res.status == "ok"
    # Two up-days but only one can fill (last bar has no next open).
    assert len(res.trades) == 1
    assert res.trades[0].side == "BUY"
    assert res.trades[0].price == 103.0  # fills at the third bar's OPEN


def test_short_history_returns_error() -> None:
    code = "def on_bar(c): pass"
    res = run_backtest(code, _bars([100.0]))
    assert res.status == "error"
    assert "2 bars" in (res.error or "")


def test_invalid_code_surfaces_error() -> None:
    res = run_backtest("import os\ndef on_bar(c): pass", _bars([1.0, 2.0]))
    assert res.status == "error"
    assert "os" in (res.error or "")


def test_buy_then_sell_realises_pnl() -> None:
    """BUY at bar 1's open (100), SELL at bar 2's open (110) → +10 pnl."""
    code = (
        "def on_bar(c):\n"
        "    n = len(c.bars)\n"
        "    if n == 1:\n"
        "        c.buy(1)\n"
        "    elif n == 2:\n"
        "        c.sell(1)\n"
    )
    bars = _bars(closes=[100.0, 105.0, 115.0], opens=[99.0, 100.0, 110.0])
    res = run_backtest(code, bars, qty_per_signal=1)
    assert res.status == "ok"
    assert len(res.trades) == 2
    assert res.trades[0].side == "BUY" and res.trades[0].price == 100.0
    assert res.trades[1].side == "SELL" and res.trades[1].price == 110.0
    assert res.trades[1].pnl == 10.0


def test_metrics_include_pnl_and_n_trades() -> None:
    code = (
        "def on_bar(c):\n"
        "    n = len(c.bars)\n"
        "    if n == 1: c.buy(1)\n"
        "    elif n == 2: c.sell(1)\n"
    )
    bars = _bars(closes=[100.0, 110.0, 120.0], opens=[100.0, 105.0, 115.0])
    res = run_backtest(code, bars, qty_per_signal=1)
    assert res.metrics is not None
    # 1 buy + 1 sell = 1 closed trade with positive pnl.
    assert res.metrics.n_trades == 1
    assert res.metrics.pnl > 0
    assert res.metrics.win_rate == 1.0


def test_equity_curve_starts_at_initial_cash_and_has_point_per_bar() -> None:
    res = run_backtest(
        "def on_bar(c): c.hold()",
        _bars([100.0, 101.0, 102.0]),
    )
    assert res.status == "ok"
    assert len(res.equity_curve) == 3
    # No trades → cash unchanged across all bars.
    for p in res.equity_curve:
        assert p.v == INITIAL_CASH
