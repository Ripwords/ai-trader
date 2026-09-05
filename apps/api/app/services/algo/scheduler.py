"""Live algo scheduler — paper-only, asyncio-based.

Runs as a single background task in the FastAPI lifespan. Every TICK_SEC
seconds it wakes, queries enabled strategies, and re-runs any that are
due based on their cadence. A strategy that emits a buy/sell intent has
that intent placed as a moomoo paper order via OpendAdapter, with the
signal (success or failure) persisted to algo_signals.

Hard rules:
- We only ever pass trd_env=SIMULATE to place_order. There is no path
  here that touches live money — the route surface enforces that
  separately.
- The global kill switch (app_settings.algo_kill_active) stops all
  emission. It does not stop fetching klines / running on_bar — that
  way the user can still see what *would* have fired in the signals
  feed once they unkill.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, TypedDict
from zoneinfo import ZoneInfo


class AccountSummary(TypedDict):
    """Lightweight subset of moomoo's portfolio response — only the totals
    the scheduler needs to populate strategy ctx.cash / ctx.account_value,
    denominated in ``currency`` (the traded symbol's quote currency)."""

    cash: float
    total_assets: float
    currency: str


_MARKET_CURRENCY = {"US": "USD", "HK": "HKD", "SH": "CNH", "SZ": "CNH", "SG": "SGD"}


def quote_currency(symbol: str, default: str = "USD") -> str:
    """Currency a moomoo symbol trades in, from its market prefix."""
    market = symbol.split(".", 1)[0].upper() if "." in symbol else ""
    return _MARKET_CURRENCY.get(market, default)


def _now_naive_utc() -> datetime:
    """Naive UTC datetime, matching the timestamp (sans-tz) columns Drizzle owns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

import pandas as pd

from app.schemas.algo import Strategy
from app.services.algo import repo
from app.services.algo.sandbox import compile_strategy

logger = logging.getLogger(__name__)

# How often the scheduler loop wakes. Must be <= the shortest cadence.
TICK_SEC = 30

# Cadence string → seconds.
CADENCE_SECS: dict[str, int] = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "1h": 60 * 60,
    "1d": 24 * 60 * 60,
}

# Max orders each strategy may place per UTC day (env-overridable). Once the
# cap is hit, further intents are recorded as blocked signals, not placed.
DEFAULT_MAX_ORDERS_PER_DAY = 20


def _max_orders_per_day() -> int:
    raw = os.environ.get("ALGO_MAX_ORDERS_PER_DAY", "").strip()
    try:
        return int(raw) if raw else DEFAULT_MAX_ORDERS_PER_DAY
    except ValueError:
        logger.warning("bad ALGO_MAX_ORDERS_PER_DAY=%r; using default %s",
                       raw, DEFAULT_MAX_ORDERS_PER_DAY)
        return DEFAULT_MAX_ORDERS_PER_DAY


def _market_hours_bypassed() -> bool:
    """ALGO_MARKET_HOURS_BYPASS=1 skips the session check (tests / dev)."""
    return os.environ.get("ALGO_MARKET_HOURS_BYPASS", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def market_is_open(symbol: str, now: datetime | None = None) -> bool:
    """Regular-session check for the symbol's market, by moomoo prefix.

    Deliberately simple: weekday + session windows in the exchange's local
    time, no holiday calendar (a closed-market kline fetch just yields stale
    bars and the strategy sees no new signal — the guard only needs to stop
    the 24/7 firing loop). Unknown prefixes are never blocked."""
    now = now or datetime.now(timezone.utc)
    prefix = symbol.split(".", 1)[0].upper() if "." in symbol else ""

    def _minutes(tz: str) -> tuple[int, int]:
        local = now.astimezone(ZoneInfo(tz))
        return local.weekday(), local.hour * 60 + local.minute

    if prefix == "US":
        wd, t = _minutes("America/New_York")
        return wd < 5 and 9 * 60 + 30 <= t < 16 * 60
    if prefix == "HK":
        wd, t = _minutes("Asia/Hong_Kong")
        return wd < 5 and (9 * 60 + 30 <= t < 12 * 60 or 13 * 60 <= t < 16 * 60)
    if prefix in ("SH", "SZ"):
        wd, t = _minutes("Asia/Shanghai")
        return wd < 5 and (9 * 60 + 30 <= t < 11 * 60 + 30 or 13 * 60 <= t < 15 * 60)
    return True


class _Ctx:
    """Minimal runtime context handed to a strategy on a live tick."""

    def __init__(
        self,
        bars: pd.DataFrame,
        position: int,
        qty: int,
        *,
        cash: float,
        account_value: float,
        allocation_pct: float,
    ) -> None:
        self.bars = bars
        self.position = position
        self.qty = qty
        self.cash = cash
        self.account_value = account_value
        self.allocation_pct = allocation_pct
        self.intent: tuple[str, int | None] | None = None

    def buy(self, qty: int | None = None) -> None:
        self.intent = ("BUY", int(qty) if qty is not None else None)

    def sell(self, qty: int | None = None) -> None:
        self.intent = ("SELL", int(qty) if qty is not None else None)

    def hold(self) -> None:
        self.intent = None

    def can_afford(self, qty: int) -> bool:
        if len(self.bars) == 0:
            return False
        last_close = float(self.bars["close"].iloc[-1])
        return int(qty) * last_close <= self.cash


def _bars_to_df(bars: list[Any]) -> pd.DataFrame:
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


def _code_hash(code: str) -> str:
    return hashlib.sha256(code.encode("utf-8")).hexdigest()[:16]


class Scheduler:
    """A single asyncio loop that ticks enabled strategies on cadence.

    Inject `place_order` and `get_position` callables — that keeps the
    scheduler decoupled from the moomoo SDK, makes it testable, and
    keeps a clear seam between strategy logic and order routing.

    `get_account_summary` is optional: when not injected, ctx.cash and
    ctx.account_value fall back to (initial_capital, initial_capital)
    so existing tests and dev setups without an OpenD bridge still work.
    """

    def __init__(
        self,
        *,
        get_klines: Callable[[str, int], Awaitable[list[Any]]],
        get_position: Callable[[str], Awaitable[int]],
        place_paper_order: Callable[[str, str, int], Awaitable[str | None]],
        get_account_summary: Callable[[str], Awaitable[AccountSummary]] | None = None,
        tick_sec: int = TICK_SEC,
    ) -> None:
        self._get_klines = get_klines
        self._get_position = get_position
        self._get_account_summary = get_account_summary
        self._place = place_paper_order
        self._tick_sec = tick_sec
        # Last-fire timestamp per strategy (monotonic seconds).
        self._last_fire: dict[str, float] = {}
        # Live pyramiding state: BUY adds since the position was last seen
        # flat, per strategy (mirrors the backtester's adds_since_flat).
        # In-memory only — a process restart with an open position forgets
        # prior adds and allows up to pyramiding_max fresh ones.
        self._adds_since_flat: dict[str, int] = {}
        # Compiled strategy cache, keyed by code-hash.
        self._compiled: dict[str, Callable[[Any], None]] = {}
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    # --- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self._task is None:
            self._stopping.clear()
            self._task = asyncio.create_task(self._run(), name="algo-scheduler")
            logger.info("algo scheduler started (tick=%ss)", self._tick_sec)

    async def stop(self) -> None:
        if self._task is None:
            return
        self._stopping.set()
        with contextlib.suppress(asyncio.CancelledError):
            self._task.cancel()
            await self._task
        self._task = None
        logger.info("algo scheduler stopped")

    # --- core loop --------------------------------------------------------

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._tick()
            except Exception:  # noqa: BLE001 — never let one tick kill the loop
                logger.exception("algo scheduler tick failed")
            try:
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=self._tick_sec
                )
            except asyncio.TimeoutError:
                continue

    async def _tick(self) -> None:
        kill = await repo.get_kill_active()
        strategies = await repo.list_strategies()
        now_mono = time.monotonic()

        for s in strategies:
            if not s.enabled:
                # Drop the timer so a re-enable doesn't immediately fire.
                self._last_fire.pop(s.id, None)
                continue
            cadence = CADENCE_SECS.get(s.cadence)
            if cadence is None:
                continue
            last = self._last_fire.get(s.id)
            if last is not None and now_mono - last < cadence:
                continue
            self._last_fire[s.id] = now_mono
            await self._fire(s, kill_active=kill)

    async def _fire(self, s: Strategy, *, kill_active: bool) -> None:
        """Run one strategy tick: fetch bars, run on_bar, route intent."""
        if not _market_hours_bypassed() and not market_is_open(s.symbol):
            # Quiet skip — no signal row; one would land every cadence tick
            # all night long. Set ALGO_MARKET_HOURS_BYPASS=1 to fire anyway.
            logger.debug("strategy %s: market closed for %s, skipping tick",
                         s.id, s.symbol)
            return

        try:
            bars = await self._get_klines(s.symbol, 200)
        except Exception as exc:  # noqa: BLE001
            await repo.append_signal(
                s.id, _now_naive_utc(), "BUY", 0, None, None,
                f"klines failed: {exc}",
            )
            return

        if len(bars) < 2:
            return

        # Compile on first sight, cache by content hash so editing the code
        # picks up automatically.
        h = _code_hash(s.code)
        on_bar = self._compiled.get(h)
        if on_bar is None:
            try:
                on_bar = compile_strategy(s.code)
            except Exception as exc:  # noqa: BLE001
                await repo.append_signal(
                    s.id, _now_naive_utc(), "BUY", 0, None, None,
                    f"compile failed: {exc}",
                )
                return
            self._compiled[h] = on_bar

        try:
            position = await self._get_position(s.symbol)
        except Exception as exc:  # noqa: BLE001
            # Never assume flat on a failed position query — a strategy that
            # believes it holds nothing will happily re-buy. Record the
            # failure and sit this tick out.
            await repo.append_signal(
                s.id, _now_naive_utc(), "BUY", 0, None, None,
                f"get_position failed: {exc}",
            )
            return
        if position <= 0:
            # Observed flat → pyramiding counter resets (backtester parity).
            self._adds_since_flat[s.id] = 0

        # Pull live paper-account totals (in the symbol's quote currency, so
        # they are comparable with its price) so strategies can gate on
        # cash / allocation_pct. If the OpenD bridge is missing or the
        # call fails, fall back to the strategy's configured initial
        # capital — the strategy still runs, it just sees a stale view.
        last_close = float(bars[-1].close)
        cash_now: float = float(s.initial_capital)
        account_value_now: float = float(s.initial_capital)
        if self._get_account_summary is not None:
            try:
                summary = await self._get_account_summary(s.symbol)
                cash_now = float(summary["cash"])
                account_value_now = float(summary["total_assets"])
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "strategy %s: account summary unavailable (%s); sizing off initial_capital",
                    s.id, exc,
                )
        position_value = position * last_close
        allocation_pct = (
            (position_value / account_value_now) * 100.0
            if account_value_now > 0
            else 0.0
        )

        # Resolve a default ctx.qty using the strategy's sizing mode so
        # `c.buy(c.qty)` works in any mode. Use last close as a fill-price
        # proxy. Prefer live account_value over initial_capital + MTM since
        # the live view already reflects realised cash + all positions.
        from app.services.algo.backtester import resolve_qty
        default_qty = max(
            1,
            resolve_qty(
                mode=s.sizing_mode, value=s.sizing_value,
                equity=account_value_now, fill_price=last_close,
            ),
        )
        ctx = _Ctx(
            _bars_to_df(bars),
            position=position,
            qty=default_qty,
            cash=cash_now,
            account_value=account_value_now,
            allocation_pct=allocation_pct,
        )
        try:
            on_bar(ctx)
        except Exception as exc:  # noqa: BLE001
            await repo.append_signal(
                s.id, _now_naive_utc(), "BUY", 0, None, None,
                f"on_bar raised: {exc}",
            )
            return

        if ctx.intent is None:
            return

        side, explicit_qty = ctx.intent
        ts = _now_naive_utc()

        if side == "SELL":
            # Backtester parity: a bare c.sell() flattens the whole position,
            # an explicit qty is capped at what is held, and there is nothing
            # to sell when flat. Sizing modes apply to entries only.
            if position <= 0:
                await repo.append_signal(
                    s.id, ts, side, 0, last_close, None,
                    "blocked: no position to sell",
                )
                return
            qty = min(int(explicit_qty), position) if explicit_qty is not None else position
        else:
            # Explicit arg from the strategy wins, otherwise reuse the default
            # we computed above (sized off the account value with last close
            # as the fill-price proxy).
            qty = max(0, int(explicit_qty)) if explicit_qty is not None else default_qty
        if qty <= 0:
            return

        if kill_active:
            await repo.append_signal(
                s.id, ts, side, qty, last_close, None,
                "blocked: kill switch active",
            )
            return

        if side == "BUY":
            adds = self._adds_since_flat.get(s.id, 0)
            if adds >= s.pyramiding_max:
                await repo.append_signal(
                    s.id, ts, side, qty, last_close, None,
                    f"blocked: pyramiding cap reached ({adds}/{s.pyramiding_max})",
                )
                return

        max_orders = _max_orders_per_day()
        orders_today = await repo.count_orders_today(s.id)
        if orders_today >= max_orders:
            await repo.append_signal(
                s.id, ts, side, qty, last_close, None,
                f"blocked: daily order cap reached ({orders_today}/{max_orders})",
            )
            return

        try:
            order_id = await self._place(s.symbol, side, qty)
            await repo.append_signal(
                s.id, ts, side, qty, last_close, order_id, None,
            )
            if side == "BUY":
                self._adds_since_flat[s.id] = (
                    self._adds_since_flat.get(s.id, 0) + 1
                )
        except Exception as exc:  # noqa: BLE001
            await repo.append_signal(
                s.id, ts, side, qty, last_close, None, f"place_order: {exc}",
            )


_singleton: Scheduler | None = None


def get_scheduler() -> Scheduler | None:
    return _singleton


def install_scheduler(s: Scheduler) -> None:
    global _singleton
    _singleton = s
