"""Bar-walk backtester for sandboxed strategies.

We deliberately don't pull in `backtrader` here — its abstractions assume a
Strategy subclass and don't fit the user's `on_bar(ctx)` shape cleanly. A
walk-forward loop over a price DataFrame is plenty for the v1 surface
(equity curve + trade list + headline metrics). Add backtrader only when a
strategy needs multi-asset, optimization, or order-routing features it
doesn't have.

Execution model (kept honest, no peeking):
- At bar t, we feed `ctx.bars = bars[0..t]` (inclusive) and call on_bar.
- Buy/sell intent is queued and executed at the OPEN of bar t+1 to avoid
  look-ahead. The final bar's signal is dropped (no next bar to fill on).
- `qty_per_signal` is the number of units per buy/sell when the strategy
  doesn't pass a qty argument.
"""

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
    TradeRecord,
)
from app.schemas.quote import Bar
from app.services.algo.sandbox import StrategyCtx, compile_strategy

INITIAL_CASH = 100_000.0


@dataclass
class _RunCtx:
    """Mutable context handed to user code each bar."""

    bars: pd.DataFrame
    position: int = 0
    qty: int = 1
    intent: tuple[str, int] | None = field(default=None, repr=False)

    def buy(self, qty: int | None = None) -> None:
        self.intent = ("BUY", int(qty) if qty is not None else self.qty)

    def sell(self, qty: int | None = None) -> None:
        self.intent = ("SELL", int(qty) if qty is not None else self.qty)

    def hold(self) -> None:
        self.intent = None


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


def _compute_metrics(
    equity_curve: list[EquityPoint], trades: list[TradeRecord]
) -> Metrics:
    """Headline metrics: PnL, win-rate, max drawdown, Sharpe (rough), n_trades."""
    if not equity_curve:
        return Metrics(pnl=0.0, win_rate=0.0, max_dd=0.0, sharpe=0.0, n_trades=0)

    pnl = equity_curve[-1].v - equity_curve[0].v

    # Max drawdown = max peak-to-trough decline.
    peak = equity_curve[0].v
    max_dd = 0.0
    for p in equity_curve:
        if p.v > peak:
            peak = p.v
        dd = (peak - p.v) / peak if peak else 0.0
        if dd > max_dd:
            max_dd = dd

    # Win rate over closed trades (those with non-zero pnl).
    closed = [t for t in trades if t.pnl != 0.0]
    wins = [t for t in closed if t.pnl > 0]
    win_rate = (len(wins) / len(closed)) if closed else 0.0

    # Sharpe: mean / std of bar-to-bar equity returns, annualised by sqrt(252)
    # if the strategy is on daily bars. We don't know the cadence here; the
    # backtester owns that, so just report the un-annualised variant.
    rets = []
    for i in range(1, len(equity_curve)):
        prev = equity_curve[i - 1].v
        cur = equity_curve[i].v
        if prev:
            rets.append((cur - prev) / prev)
    if len(rets) > 1:
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        std = math.sqrt(var)
        sharpe = (mean / std) if std else 0.0
    else:
        sharpe = 0.0

    return Metrics(
        pnl=round(pnl, 4),
        win_rate=round(win_rate, 4),
        max_dd=round(max_dd, 4),
        sharpe=round(sharpe, 4),
        n_trades=len(closed),
    )


def run_backtest(
    code: str,
    bars: list[Bar],
    qty_per_signal: int = 1,
) -> BacktestResult:
    """Walk `bars` forward, calling the user's on_bar at each step.

    Returns a result containing equity curve, trade list, and metrics. The
    BacktestResult.run_id is left empty here; the router/repo assigns it
    when persisting.
    """
    if len(bars) < 2:
        return BacktestResult(
            run_id="",
            status="error",
            error="need at least 2 bars to backtest",
        )

    try:
        on_bar = compile_strategy(code)
    except Exception as exc:  # noqa: BLE001 — surface validation/compile errors
        return BacktestResult(run_id="", status="error", error=str(exc))

    df = _bars_to_df(bars)

    cash = INITIAL_CASH
    position = 0
    avg_cost = 0.0  # for FIFO-style realised pnl on sells
    equity_curve: list[EquityPoint] = []
    trades: list[TradeRecord] = []

    for i in range(len(df) - 1):  # last bar can't fill on a next-bar open
        bars_so_far = df.iloc[: i + 1].reset_index(drop=True)
        ctx = _RunCtx(bars=bars_so_far, position=position, qty=qty_per_signal)
        try:
            on_bar(ctx)
        except Exception as exc:  # noqa: BLE001
            return BacktestResult(
                run_id="",
                status="error",
                error=f"strategy raised on bar {i}: {exc}",
            )

        # Execute intent at next bar's open.
        if ctx.intent is not None:
            side, qty = ctx.intent
            if qty > 0:
                fill_price = float(df.iloc[i + 1]["open"])
                fill_ts: datetime = df.iloc[i + 1]["time"].to_pydatetime()
                if side == "BUY":
                    new_cost = avg_cost * position + fill_price * qty
                    position += qty
                    avg_cost = new_cost / position if position else 0.0
                    cash -= fill_price * qty
                    trades.append(
                        TradeRecord(
                            ts=fill_ts,
                            side="BUY",
                            qty=qty,
                            price=fill_price,
                            pnl=0.0,
                        )
                    )
                elif side == "SELL" and position > 0:
                    qty = min(qty, position)
                    pnl = (fill_price - avg_cost) * qty
                    position -= qty
                    cash += fill_price * qty
                    if position == 0:
                        avg_cost = 0.0
                    trades.append(
                        TradeRecord(
                            ts=fill_ts,
                            side="SELL",
                            qty=qty,
                            price=fill_price,
                            pnl=round(pnl, 4),
                        )
                    )

        # Mark-to-market equity at bar i's close.
        close_i = float(df.iloc[i]["close"])
        equity_curve.append(
            EquityPoint(
                t=df.iloc[i]["time"].to_pydatetime(),
                v=round(cash + position * close_i, 4),
            )
        )

    # Tail point at last bar's close (no trade can have fired here).
    last_close = float(df.iloc[-1]["close"])
    equity_curve.append(
        EquityPoint(
            t=df.iloc[-1]["time"].to_pydatetime(),
            v=round(cash + position * last_close, 4),
        )
    )

    return BacktestResult(
        run_id="",
        status="ok",
        equity_curve=equity_curve,
        trades=trades,
        metrics=_compute_metrics(equity_curve, trades),
    )
