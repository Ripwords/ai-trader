"""Tests for the bar-walk backtester engine."""

from __future__ import annotations

from datetime import datetime, timedelta

from app.schemas.quote import Bar
from app.services.algo.backtester import (
    DEFAULT_INITIAL_CAPITAL,
    resolve_qty,
    run_backtest,
)


def _bars(closes: list[float], opens: list[float] | None = None) -> list[Bar]:
    out: list[Bar] = []
    base = datetime(2026, 1, 1)
    for i, c in enumerate(closes):
        o = opens[i] if opens else c
        out.append(Bar(
            time=base + timedelta(days=i),
            open=o, high=max(o, c), low=min(o, c),
            close=c, volume=1_000, turnover=1_000.0 * c,
        ))
    return out


# ---- resolve_qty -----------------------------------------------------------


def test_resolve_qty_fixed_qty_floors_value() -> None:
    assert resolve_qty(mode="fixed_qty", value=3.7, equity=10_000, fill_price=50) == 3


def test_resolve_qty_pct_equity_uses_equity_and_fill_price() -> None:
    assert resolve_qty(mode="pct_equity", value=25, equity=10_000, fill_price=50) == 50


def test_resolve_qty_fixed_cash_divides_value_by_fill_price() -> None:
    assert resolve_qty(mode="fixed_cash", value=1000, equity=10_000, fill_price=33) == 30


def test_resolve_qty_zero_when_not_enough_capital() -> None:
    assert resolve_qty(mode="fixed_cash", value=10, equity=0, fill_price=50) == 0


# ---- core fill semantics ---------------------------------------------------


def test_short_history_returns_error() -> None:
    res = run_backtest("def on_bar(c): pass", _bars([100.0]))
    assert res.status == "error"
    assert "2 bars" in (res.error or "")


def test_invalid_code_surfaces_error() -> None:
    res = run_backtest("import os\ndef on_bar(c): pass", _bars([1.0, 2.0]))
    assert res.status == "error"


def test_buy_fills_at_next_open_with_slippage() -> None:
    # Strategy buys on bar 0, fills at bar 1 open (=100). With 5 bps slippage
    # the fill price is 100 * 1.0005 = 100.05.
    code = (
        "def on_bar(c):\n"
        "    if len(c.bars) == 1:\n"
        "        c.buy(1)\n"
    )
    bars = _bars(closes=[99.0, 101.0, 102.0], opens=[99.0, 100.0, 102.0])
    res = run_backtest(code, bars, slippage_bps=5, commission_bps=0)
    assert res.status == "ok"
    assert len(res.trades) == 1
    assert res.trades[0].side == "BUY"
    assert abs(res.trades[0].price - 100.05) < 1e-6


def test_sell_pnl_is_net_of_commissions_and_slippage() -> None:
    """BUY at bar1 open=100 with 5 bps slip + 10 bps fee, SELL at bar2 open=110
    with 5 bps slip + 10 bps fee. Realised pnl should be net of all costs."""
    code = (
        "def on_bar(c):\n"
        "    n = len(c.bars)\n"
        "    if n == 1: c.buy(1)\n"
        "    elif n == 2: c.sell(1)\n"
    )
    bars = _bars(closes=[100.0, 105.0, 115.0], opens=[99.0, 100.0, 110.0])
    res = run_backtest(code, bars, slippage_bps=5, commission_bps=10)
    assert res.status == "ok"
    assert len(res.trades) == 2
    buy = res.trades[0]
    sell = res.trades[1]
    assert abs(buy.price - 100.05) < 1e-6
    assert abs(sell.price - 109.945) < 1e-6  # 110 * 0.9995
    # avg_cost = buy_price + buy_commission/qty = 100.05 + 100.05*10/10000
    #         = 100.05 + 0.10005 = 100.15005
    # sell_commission = 109.945 * 10/10000 = 0.109945
    # pnl = (109.945 - 100.15005) * 1 - 0.109945 ≈ 9.685005
    assert abs(sell.pnl - 9.685) < 0.01
    assert sell.pnl > 0  # still a winner after costs


# ---- sizing modes ----------------------------------------------------------


def test_sizing_pct_equity_buys_proportional_qty() -> None:
    # 25% of $100k equity = $25k; bar1 open=$50 with 0 slip = 500 shares.
    code = "def on_bar(c):\n    if len(c.bars) == 1: c.buy()\n"
    bars = _bars(closes=[50.0, 50.0], opens=[50.0, 50.0])
    res = run_backtest(
        code, bars,
        initial_capital=100_000,
        commission_bps=0, slippage_bps=0,
        sizing_mode="pct_equity", sizing_value=25,
    )
    assert res.status == "ok"
    assert res.trades[0].qty == 500


def test_sizing_fixed_cash_buys_floor_value_over_price() -> None:
    code = "def on_bar(c):\n    if len(c.bars) == 1: c.buy()\n"
    bars = _bars(closes=[33.0, 33.0], opens=[33.0, 33.0])
    res = run_backtest(
        code, bars,
        initial_capital=10_000,
        commission_bps=0, slippage_bps=0,
        sizing_mode="fixed_cash", sizing_value=1_000,
    )
    assert res.trades[0].qty == 30  # floor(1000/33)


# ---- pyramiding ------------------------------------------------------------


def test_pyramiding_cap_blocks_extra_buys() -> None:
    """Strategy attempts to BUY on every bar. With pyramiding_max=2, only the
    first two BUYs fill; subsequent ones are silently dropped until SELL flatten."""
    code = "def on_bar(c):\n    c.buy(1)\n"
    bars = _bars(closes=[10.0, 10.0, 10.0, 10.0, 10.0])
    res = run_backtest(
        code, bars,
        commission_bps=0, slippage_bps=0,
        sizing_mode="fixed_qty", sizing_value=1,
        pyramiding_max=2,
    )
    assert res.status == "ok"
    # bars 0..3 each schedule a BUY for bar 1..4. With cap=2, only first 2 fill.
    assert sum(1 for t in res.trades if t.side == "BUY") == 2


def test_pyramiding_resets_after_flatten() -> None:
    """After a SELL takes position to 0, BUYs should be allowed again."""
    code = (
        "def on_bar(c):\n"
        "    n = len(c.bars)\n"
        "    if n in (1, 2): c.buy(1)\n"  # 2 buys
        "    elif n == 3: c.sell(2)\n"     # flatten
        "    elif n == 4: c.buy(1)\n"      # should be allowed
    )
    bars = _bars(closes=[10.0]*6)
    res = run_backtest(
        code, bars,
        commission_bps=0, slippage_bps=0,
        pyramiding_max=2,
    )
    buys = [t for t in res.trades if t.side == "BUY"]
    sells = [t for t in res.trades if t.side == "SELL"]
    assert len(buys) == 3, f"expected 3 buys, got {len(buys)}: {res.trades}"
    assert len(sells) == 1


# ---- benchmark + metrics ---------------------------------------------------


def test_benchmark_curve_is_buy_and_hold() -> None:
    """Benchmark = floor(capital/close_0) shares + leftover cash, marked each bar."""
    bars = _bars(closes=[100.0, 110.0, 121.0])
    res = run_backtest(
        "def on_bar(c): c.hold()", bars,
        initial_capital=10_000,
    )
    assert res.status == "ok"
    assert len(res.benchmark_curve) == 3
    # 10_000 / 100 = 100 shares, 0 leftover.
    # bar0 = 100 * 100 = 10_000; bar2 = 100 * 121 = 12_100.
    assert res.benchmark_curve[0].v == 10_000
    assert res.benchmark_curve[2].v == 12_100
    assert res.metrics is not None
    assert res.metrics.benchmark_pnl == 2_100


def test_metrics_split_fills_and_round_trips() -> None:
    """Strategy that BUYs but never SELLs: fills > 0, round_trips == 0,
    win_rate == 0 (denominator empty). The bug we're fixing."""
    code = "def on_bar(c):\n    if len(c.bars) <= 3: c.buy(1)\n"
    bars = _bars(closes=[10.0]*5)
    res = run_backtest(
        code, bars,
        commission_bps=0, slippage_bps=0,
        pyramiding_max=10,
    )
    assert res.metrics is not None
    assert res.metrics.fills > 0
    assert res.metrics.round_trips == 0
    assert res.metrics.win_rate == 0.0


def test_metrics_win_loss_count_after_costs() -> None:
    """A trade that's barely positive gross can flip to a loss after commission."""
    code = (
        "def on_bar(c):\n"
        "    n = len(c.bars)\n"
        "    if n == 1: c.buy(100)\n"
        "    elif n == 2: c.sell(100)\n"
    )
    # Open 100, close at 100.10 (10 bps gross). 10 bps round-trip commission
    # eats it.
    bars = _bars(closes=[100.0, 100.10, 100.10], opens=[100.0, 100.0, 100.10])
    res = run_backtest(
        code, bars, commission_bps=10, slippage_bps=0,
    )
    assert res.metrics is not None
    assert res.metrics.fills == 2
    assert res.metrics.round_trips == 1
    sell_pnl = next(t.pnl for t in res.trades if t.side == "SELL")
    assert sell_pnl <= 0  # commission-eaten
    assert res.metrics.losses == 1


def test_default_initial_capital_constant_unchanged() -> None:
    assert DEFAULT_INITIAL_CAPITAL == 100_000.0
