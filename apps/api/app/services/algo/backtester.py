"""Bar-walk backtester for sandboxed strategies."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable

import pandas as pd

from app.schemas.algo import (
    BacktestResult,
    EquityPoint,
    Metrics,
    SizingMode,
    TradeRecord,
)
from app.schemas.quote import Bar
from app.services.algo.sandbox import compile_strategy

DEFAULT_INITIAL_CAPITAL = 100_000.0


@dataclass
class _RunCtx:
    bars: pd.DataFrame
    position: int = 0
    qty: int = 1
    intent: tuple[str, int | None] | None = field(default=None, repr=False)

    def buy(self, qty: int | None = None) -> None:
        self.intent = ("BUY", int(qty) if qty is not None else None)

    def sell(self, qty: int | None = None) -> None:
        self.intent = ("SELL", int(qty) if qty is not None else None)

    def hold(self) -> None:
        self.intent = None


def resolve_qty(
    *,
    mode: SizingMode,
    value: float,
    equity: float,
    fill_price: float,
) -> int:
    """How many shares to fill given the sizing mode and current equity.

    fixed_qty   — shares directly (floor of value)
    pct_equity  — value is a percentage 0..100 of current equity
    fixed_cash  — value is dollars to commit to this trade
    Returns 0 when there isn't enough capital to buy a single share.
    """
    if fill_price <= 0:
        return 0
    if mode == "fixed_qty":
        return max(0, math.floor(value))
    if mode == "pct_equity":
        cash_for_trade = max(0.0, equity) * (value / 100.0)
        return max(0, math.floor(cash_for_trade / fill_price))
    if mode == "fixed_cash":
        return max(0, math.floor(max(0.0, value) / fill_price))
    raise ValueError(f"unknown sizing mode: {mode}")


def _bars_to_df(bars: list[Bar]) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "time": [b.time for b in bars],
            "open": [b.open for b in bars],
            "high": [b.high for b in bars],
            "low": [b.low for b in bars],
            "close": [b.close for b in bars],
            "volume": [b.volume for b in bars],
        }
    )


def run_backtest(
    code: str,
    bars: list[Bar],
    *,
    initial_capital: float = DEFAULT_INITIAL_CAPITAL,
    commission_bps: int = 10,
    slippage_bps: int = 5,
    sizing_mode: SizingMode = "fixed_qty",
    sizing_value: float = 1,
    pyramiding_max: int = 1,
) -> BacktestResult:
    """Walk `bars` forward, calling the user's on_bar at each step."""
    if len(bars) < 2:
        return BacktestResult(
            run_id="", status="error", error="need at least 2 bars to backtest",
        )
    try:
        on_bar = compile_strategy(code)
    except Exception as exc:  # noqa: BLE001
        return BacktestResult(run_id="", status="error", error=str(exc))

    df = _bars_to_df(bars)

    cash = float(initial_capital)
    position = 0
    avg_cost = 0.0  # includes buy slippage AND buy commission, prorated per share
    adds_since_flat = 0
    slip = slippage_bps / 10_000.0
    fee = commission_bps / 10_000.0

    equity_curve: list[EquityPoint] = []
    trades: list[TradeRecord] = []

    for i in range(len(df) - 1):
        bars_so_far = df.iloc[: i + 1].reset_index(drop=True)
        # ctx.qty exposes a resolved default so strategies that pass it
        # explicitly — `c.buy(c.qty)` — still produce sane sizes under
        # pct_equity / fixed_cash modes. We use the current bar's close as
        # a fill_price proxy; the actual fill recomputes against next-bar open.
        close_now = float(df.iloc[i]["close"])
        equity_now = cash + position * close_now
        default_qty = max(
            1,
            resolve_qty(
                mode=sizing_mode, value=sizing_value,
                equity=equity_now, fill_price=close_now,
            ),
        )
        ctx = _RunCtx(bars=bars_so_far, position=position, qty=default_qty)
        try:
            on_bar(ctx)
        except Exception as exc:  # noqa: BLE001
            return BacktestResult(
                run_id="", status="error",
                error=f"strategy raised on bar {i}: {exc}",
            )

        if ctx.intent is not None:
            side, explicit_qty = ctx.intent
            next_open = float(df.iloc[i + 1]["open"])
            fill_ts: datetime = df.iloc[i + 1]["time"].to_pydatetime()

            if side == "BUY":
                fill_price = next_open * (1 + slip)
                if adds_since_flat >= pyramiding_max:
                    pass  # rejected — already at pyramiding cap
                else:
                    equity_now = cash + position * float(df.iloc[i]["close"])
                    qty = (
                        max(0, int(explicit_qty))
                        if explicit_qty is not None
                        else resolve_qty(
                            mode=sizing_mode,
                            value=sizing_value,
                            equity=equity_now,
                            fill_price=fill_price,
                        )
                    )
                    if qty > 0:
                        gross = fill_price * qty
                        commission = gross * fee
                        if cash >= gross + commission:
                            new_cost = avg_cost * position + gross + commission
                            position += qty
                            avg_cost = new_cost / position
                            cash -= gross + commission
                            adds_since_flat += 1
                            trades.append(TradeRecord(
                                ts=fill_ts, side="BUY", qty=qty,
                                price=fill_price, pnl=0.0,
                            ))

            elif side == "SELL" and position > 0:
                fill_price = next_open * (1 - slip)
                # Bare c.sell() flattens the position. Sizing modes apply to entries only;
                # exits are full-or-explicit. Use c.sell(N) for a partial exit.
                qty = min(int(explicit_qty), position) if explicit_qty is not None else position
                if qty > 0:
                    gross = fill_price * qty
                    commission = gross * fee
                    pnl = (fill_price - avg_cost) * qty - commission
                    position -= qty
                    cash += gross - commission
                    if position == 0:
                        avg_cost = 0.0
                        adds_since_flat = 0
                    trades.append(TradeRecord(
                        ts=fill_ts, side="SELL", qty=qty,
                        price=fill_price, pnl=round(pnl, 4),
                    ))

        close_i = float(df.iloc[i]["close"])
        equity_curve.append(EquityPoint(
            t=df.iloc[i]["time"].to_pydatetime(),
            v=round(cash + position * close_i, 4),
        ))

    last_close = float(df.iloc[-1]["close"])
    equity_curve.append(EquityPoint(
        t=df.iloc[-1]["time"].to_pydatetime(),
        v=round(cash + position * last_close, 4),
    ))

    benchmark_curve = _build_benchmark_curve(df, initial_capital)
    metrics = _compute_metrics(equity_curve, trades, benchmark_curve)

    return BacktestResult(
        run_id="", status="ok",
        equity_curve=equity_curve,
        benchmark_curve=benchmark_curve,
        price_bars=bars,
        trades=trades,
        metrics=metrics,
    )


def _build_benchmark_curve(df: pd.DataFrame, initial_capital: float) -> list[EquityPoint]:
    """Buy as many shares as possible with initial_capital at bar 0's close,
    mark to market each subsequent close. No costs applied — this is the
    idealised hold reference."""
    if df.empty:
        return []
    close_0 = float(df.iloc[0]["close"])
    if close_0 <= 0:
        return []
    qty = math.floor(initial_capital / close_0)
    leftover = initial_capital - qty * close_0
    return [
        EquityPoint(
            t=df.iloc[i]["time"].to_pydatetime(),
            v=round(leftover + qty * float(df.iloc[i]["close"]), 4),
        )
        for i in range(len(df))
    ]


def _compute_metrics(
    equity_curve: list[EquityPoint],
    trades: list[TradeRecord],
    benchmark_curve: list[EquityPoint],
) -> Metrics:
    if not equity_curve:
        return Metrics(
            pnl=0.0, win_rate=0.0, max_dd=0.0, sharpe=0.0,
            fills=0, round_trips=0, wins=0, losses=0, benchmark_pnl=0.0,
        )
    pnl = equity_curve[-1].v - equity_curve[0].v

    peak = equity_curve[0].v
    max_dd = 0.0
    for p in equity_curve:
        if p.v > peak:
            peak = p.v
        dd = (peak - p.v) / peak if peak else 0.0
        if dd > max_dd:
            max_dd = dd

    closed = [t for t in trades if t.side == "SELL"]
    wins = sum(1 for t in closed if t.pnl > 0)
    losses = sum(1 for t in closed if t.pnl <= 0)
    round_trips = wins + losses
    win_rate = (wins / round_trips) if round_trips else 0.0

    rets = []
    for i in range(1, len(equity_curve)):
        prev, cur = equity_curve[i - 1].v, equity_curve[i].v
        if prev:
            rets.append((cur - prev) / prev)
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        std = math.sqrt(var)
        sharpe = (mean / std) if std else 0.0
    else:
        sharpe = 0.0

    benchmark_pnl = (
        benchmark_curve[-1].v - benchmark_curve[0].v
        if benchmark_curve else 0.0
    )

    return Metrics(
        pnl=round(pnl, 4),
        win_rate=round(win_rate, 4),
        max_dd=round(max_dd, 4),
        sharpe=round(sharpe, 4),
        fills=len(trades),
        round_trips=round_trips,
        wins=wins,
        losses=losses,
        benchmark_pnl=round(benchmark_pnl, 4),
    )
