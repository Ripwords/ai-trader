"""Realized return vs SPY for a past agents decision.

:func:`compute_realized_return` fetches daily bars for the symbol and SPY via
the OpenD client and computes the alpha (symbol return minus benchmark
return) over ``[trade_date, trade_date + horizon_days]``.
:func:`_classify_outcome` maps ``rating + alpha`` to
``correct | wrong | neutral``. The backtest harness is the only caller.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal, Protocol

Outcome = Literal["correct", "wrong", "neutral"]


@dataclass
class RealizedReturn:
    realized_return: float
    benchmark_return: float
    alpha: float
    outcome: Outcome


class _OpenDLike(Protocol):
    """Subset of the async OpenD client this module relies on."""

    async def get_kline(
        self, ticker: str, ktype: str, num: int
    ) -> list[dict[str, Any]]: ...


def _classify_outcome(rating: str, alpha: float) -> Outcome:
    """Map ``rating + alpha`` to an outcome label.

    Precedence matters:
    * Small alpha (|alpha| < 0.5) is neutral, *except* for ``hold`` which is
      'correct' when the move was small (the trader called it right).
    * Bullish ratings (buy/strong-buy) with positive alpha → correct.
    * Bearish ratings (sell/reduce) with negative alpha → correct.
    * ``hold`` with |alpha| < 1.0 → correct (a slightly larger band, still
      a reasonable hold). Otherwise → wrong.
    """
    if abs(alpha) < 0.5:
        if rating == "hold":
            return "correct"
        return "neutral"
    if rating in ("strong-buy", "buy") and alpha > 0:
        return "correct"
    if rating in ("sell", "reduce") and alpha < 0:
        return "correct"
    if rating == "hold" and abs(alpha) < 1.0:
        return "correct"
    return "wrong"


def _bar_date(bar: dict[str, Any]) -> date | None:
    """Extract the bar's date as a :class:`date`.

    Test fixtures use ``time_key`` (the moomoo SDK's native field); the
    production :class:`Bar` pydantic model uses ``time`` (a datetime). We
    accept either — checking ``time_key`` first to keep existing tests
    deterministic — and tolerate date-only ISO strings, full ISO datetimes,
    and :class:`datetime` instances. Returns ``None`` for malformed bars so
    the caller can skip them rather than raise.
    """
    raw = bar.get("time_key", bar.get("time"))
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        try:
            return datetime.fromisoformat(text).date()
        except ValueError:
            return None


def _closest_bar_at_or_after(bars: list[dict], target: date) -> dict | None:
    """Return the first bar with ``time_key`` >= ``target`` (i.e. trade_date).

    The realized-return contract is "buy at the first available close on or
    after the decision day"; weekends and holidays mean the trade_date may
    fall on a non-trading day, so we walk forward to the first qualifying
    bar.
    """
    for bar in bars:
        d = _bar_date(bar)
        if d is not None and d >= target:
            return bar
    return None


def _closest_bar_at_or_before(bars: list[dict], target: date) -> dict | None:
    """Return the last bar with ``time_key`` <= ``target`` (i.e. exit day).

    The exit is "sell at the close on the horizon day"; if the horizon day
    is a non-trading day, we fall back to the most recent prior trading
    close. Since :func:`compute_realized_return` may be called before the
    horizon has even elapsed (in which case the latest bar is the best we
    have), this handles both "horizon in the past" and "horizon already
    happened" cases uniformly.
    """
    candidate: dict | None = None
    for bar in bars:
        d = _bar_date(bar)
        if d is None:
            continue
        if d <= target:
            candidate = bar
        else:
            break
    return candidate


async def _maybe_await_kline(
    opend: Any, symbol: str, *, ktype: str, num: int
) -> list[dict]:
    """Fetch ``num`` daily bars whether ``opend.get_kline`` is sync or async.

    The production :class:`OpendAdapter` is synchronous (it wraps the moomoo
    OpenQuoteContext, which is itself blocking). The toolkit was originally
    written against an async client; tests mock with :class:`AsyncMock`. We
    accommodate both shapes here so the return calculation works
    against either: an awaitable result is awaited, otherwise the bare
    return value is used. Sync calls are routed through
    :func:`asyncio.to_thread` so we don't block the event loop.

    Returns a list of bar dicts (``[{time_key, close, ...}, ...]``).
    Production OpendAdapter returns a :class:`KLineResponse`; if so, fall
    back to ``.bars`` and convert each :class:`Bar` model to a dict.
    """
    if inspect.iscoroutinefunction(getattr(opend, "get_kline", None)):
        result = await opend.get_kline(symbol, ktype=ktype, num=num)
    else:
        result = await asyncio.to_thread(
            opend.get_kline, symbol, ktype=ktype, num=num
        )
    # AsyncMock-backed tests usually surface a list directly. Production's
    # OpendAdapter wraps bars in a KLineResponse pydantic model with a
    # ``.bars`` attribute; coerce.
    if isinstance(result, list):
        return result
    bars = getattr(result, "bars", None)
    if bars is None:
        return []
    return [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in bars]


async def compute_realized_return(
    opend: _OpenDLike,
    symbol: str,
    trade_date: date,
    rating: str,
    horizon_days: int,
) -> RealizedReturn:
    """Compute alpha vs SPY over the ``[trade_date, trade_date + horizon_days]`` window.

    Bars are fetched via :func:`_maybe_await_kline`; we ask for enough
    history to cover ``trade_date`` even when the decision is N days old:
    ``num = max(horizon_days + 5, days_since_trade + horizon_days + 10)``.
    Window slicing is by ``time_key``, so weekends/holidays are tolerated
    on either end.

    Raises :class:`ValueError` when bars don't cover the trade_date; the
    backtest records the message as the pair's error.
    """
    today = date.today()
    days_since = max(0, (today - trade_date).days)
    num = max(horizon_days + 5, days_since + horizon_days + 10)

    sym_bars = await _maybe_await_kline(opend, symbol, ktype="K_DAY", num=num)
    spy_bars = await _maybe_await_kline(opend, "US.SPY", ktype="K_DAY", num=num)
    if not sym_bars or not spy_bars:
        raise ValueError(f"insufficient bars to compute return for {symbol}")

    horizon_date = trade_date + timedelta(days=horizon_days)

    sym_entry = _closest_bar_at_or_after(sym_bars, trade_date)
    sym_exit = _closest_bar_at_or_before(sym_bars, horizon_date)
    spy_entry = _closest_bar_at_or_after(spy_bars, trade_date)
    spy_exit = _closest_bar_at_or_before(spy_bars, horizon_date)

    if not (sym_entry and sym_exit and spy_entry and spy_exit):
        raise ValueError(
            f"insufficient history for trade_date {trade_date.isoformat()} "
            f"+ horizon {horizon_days}d for {symbol}"
        )
    # When entry == exit (e.g. only one bar in the window, or horizon hasn't
    # elapsed), the return is 0 — that's still a meaningful "no movement"
    # data point and we don't want to raise.
    sym_ret = (sym_exit["close"] / sym_entry["close"] - 1) * 100
    spy_ret = (spy_exit["close"] / spy_entry["close"] - 1) * 100
    alpha = sym_ret - spy_ret
    return RealizedReturn(
        realized_return=round(sym_ret, 4),
        benchmark_return=round(spy_ret, 4),
        alpha=round(alpha, 4),
        outcome=_classify_outcome(rating, alpha),
    )
