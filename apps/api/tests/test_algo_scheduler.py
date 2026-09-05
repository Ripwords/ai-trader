"""Tests for the live algo scheduler (paper-only).

The scheduler is built around three injected callables (get_klines,
get_position, place_paper_order). We don't test the asyncio loop driver
directly — we exercise `_tick` / `_fire` against fakes and the real
asyncpg pool that the rest of the algo code uses.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta
from typing import Any

import pytest

from app.schemas.algo import StrategyCreate
from app.services.algo import repo
from app.services.algo.scheduler import Scheduler


pytestmark = pytest.mark.asyncio


# --- fixtures -------------------------------------------------------------


@pytest.fixture(autouse=True)
def _bypass_market_hours(monkeypatch: pytest.MonkeyPatch) -> None:
    """Scheduler tests run at arbitrary wall-clock times; bypass the
    market-hours guard by default. Tests that exercise the guard remove
    the env var themselves."""
    monkeypatch.setenv("ALGO_MARKET_HOURS_BYPASS", "1")


@pytest.fixture
def algo_db_url(request: pytest.FixtureRequest) -> str:
    """DB URL for the scheduler's repo. Prefers a reachable DATABASE_URL
    (the compose stack); otherwise falls back to the session-scoped postgres
    testcontainer from conftest (skips only when Docker is unavailable too).

    Resolved in a SYNC fixture because ``pg_container`` bootstraps its schema
    via ``asyncio.run`` — it can't be requested from inside an async fixture's
    already-running event loop."""
    url = os.environ.get("DATABASE_URL")
    if url:
        import socket
        from urllib.parse import urlparse

        parsed = urlparse(url)
        try:
            with socket.create_connection(
                (parsed.hostname or "localhost", parsed.port or 5432), timeout=1
            ):
                return url
        except OSError:
            pass
    return str(request.getfixturevalue("pg_container"))


@pytest.fixture
async def db_pool(algo_db_url: str) -> Any:
    """Per-test repo pool (pytest-asyncio gives each test a fresh event loop,
    so we open AND close the pool per-test — asyncpg pools are loop-bound)."""
    pool = await repo.init_pool(algo_db_url)
    try:
        yield pool
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM algo_signals")
            await conn.execute("DELETE FROM algo_runs")
            await conn.execute("DELETE FROM algo_strategies")
            await conn.execute(
                "DELETE FROM app_settings WHERE key = 'algo_kill_active'"
            )
        await repo.close_pool()


def _bar(ts: datetime, close: float) -> Any:
    """Minimal bar object matching the schema.quote.Bar shape the scheduler reads."""

    class B:
        def __init__(self) -> None:
            self.time = ts
            self.open = close
            self.high = close
            self.low = close
            self.close = close
            self.volume = 1
            self.turnover = float(close)

    return B()


# --- scheduler logic ------------------------------------------------------


async def _make_strategy(code: str, cadence: str = "1m") -> str:
    """Insert a strategy, flip enabled=True, and return its id."""
    from app.schemas.algo import StrategyUpdate

    s = await repo.create_strategy(
        StrategyCreate(
            name="t",
            symbol="US.NVDA",
            cadence=cadence,
            code=code,
            initial_capital=100_000,
            commission_bps=10,
            slippage_bps=5,
            sizing_mode="fixed_qty",
            sizing_value=1,
            pyramiding_max=1,
        )
    )
    await repo.update_strategy(s.id, StrategyUpdate(enabled=True))
    return s.id


async def test_tick_runs_strategy_and_records_buy_signal(db_pool: Any) -> None:
    sid = await _make_strategy(
        "def on_bar(c):\n"
        "    if c.bars['close'].iloc[-1] > c.bars['close'].iloc[-2]: c.buy(c.qty)\n"
        "    else: c.hold()\n"
    )

    placed: list[tuple[str, str, int]] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [
            _bar(datetime(2026, 1, 1), 100.0),
            _bar(datetime(2026, 1, 2), 110.0),
        ]

    async def fake_position(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return "ORD-1"

    sch = Scheduler(
        get_klines=fake_klines,
        get_position=fake_position,
        place_paper_order=fake_place,
    )
    await sch._tick()  # one synchronous tick

    assert placed == [("US.NVDA", "BUY", 1)]
    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1
    assert sigs[0].side == "BUY"
    assert sigs[0].order_id == "ORD-1"
    assert sigs[0].error is None


async def test_disabled_strategy_does_not_fire(db_pool: Any) -> None:
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")
    from app.schemas.algo import StrategyUpdate

    await repo.update_strategy(sid, StrategyUpdate(enabled=False))

    placed: list[tuple[str, str, int]] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 110.0)]

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return "X"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()
    assert placed == []


async def test_kill_switch_blocks_order_but_records_signal(db_pool: Any) -> None:
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")
    await repo.set_kill_active(True)

    placed: list[Any] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 110.0)]

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return "X"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()

    assert placed == []  # kill switch must block the place_order call
    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1
    assert sigs[0].error == "blocked: kill switch active"
    assert sigs[0].order_id is None


async def test_cadence_throttles_re_runs(db_pool: Any) -> None:
    sid = await _make_strategy(
        "def on_bar(c): c.buy(c.qty)\n",
        cadence="1d",  # 24h — second tick within the test must be skipped
    )

    place_calls = 0

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 110.0)]

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        nonlocal place_calls
        place_calls += 1
        return f"X{place_calls}"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()
    await sch._tick()  # immediately after — must NOT fire again

    assert place_calls == 1


async def test_klines_failure_records_signal_and_does_not_crash(db_pool: Any) -> None:
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")

    async def fake_klines(sym: str, num: int) -> list[Any]:
        raise RuntimeError("opend down")

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        raise AssertionError("should not be called when klines fail")

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()

    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1
    assert "opend down" in (sigs[0].error or "")


# --- risk guards ----------------------------------------------------------


_TWO_BARS_UP = [
    _bar(datetime(2026, 1, 1), 100.0),
    _bar(datetime(2026, 1, 2), 110.0),
]


async def test_get_position_failure_skips_tick_with_error_signal(db_pool: Any) -> None:
    """A broken position query must NEVER be treated as position=0 — the
    strategy would double-buy. Record an error signal and skip the tick."""
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        raise RuntimeError("position query blew up")

    async def fake_place(sym: str, side: str, qty: int) -> str:
        raise AssertionError("must not place when get_position fails")

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()

    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1
    assert "get_position" in (sigs[0].error or "")
    assert sigs[0].order_id is None


async def test_pyramiding_cap_blocks_additional_adds(db_pool: Any) -> None:
    """pyramiding_max=1: after one live BUY fills, further BUY intents are
    blocked until the position goes flat again (mirrors the backtester)."""
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")  # pyramiding_max=1

    placed: list[tuple[str, str, int]] = []
    position = 0

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        return position

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return f"ORD-{len(placed)}"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()
    position = 1  # the first BUY filled
    sch._last_fire.clear()  # bypass cadence throttle for the second tick
    await sch._tick()

    assert len(placed) == 1  # second BUY must not reach place_order
    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 2
    blocked = [s for s in sigs if s.error and "pyramiding" in s.error]
    assert len(blocked) == 1
    assert blocked[0].order_id is None


async def test_pyramiding_counter_resets_when_flat(db_pool: Any) -> None:
    """Once the position is observed flat again, a new BUY is allowed."""
    await _make_strategy("def on_bar(c): c.buy(c.qty)\n")

    placed: list[str] = []
    positions = iter([0, 1, 0])  # buy -> holding (blocked) -> flat (buy again)

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        return next(positions)

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append(side)
        return f"ORD-{len(placed)}"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    for _ in range(3):
        await sch._tick()
        sch._last_fire.clear()

    assert placed == ["BUY", "BUY"]  # tick 2 was blocked, tick 3 allowed


async def test_daily_order_cap_blocks_after_limit(
    db_pool: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ALGO_MAX_ORDERS_PER_DAY", "1")
    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")

    placed: list[str] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        return 0  # always flat, so pyramiding never blocks

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append(side)
        return f"ORD-{len(placed)}"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()
    sch._last_fire.clear()
    await sch._tick()

    assert len(placed) == 1
    sigs = await repo.list_signals(strategy_id=sid)
    blocked = [s for s in sigs if s.error and "order cap" in s.error]
    assert len(blocked) == 1
    assert blocked[0].order_id is None


async def test_market_closed_skips_fire(
    db_pool: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.algo import scheduler as sched_mod

    monkeypatch.delenv("ALGO_MARKET_HOURS_BYPASS", raising=False)
    monkeypatch.setattr(sched_mod, "market_is_open", lambda symbol: False)

    sid = await _make_strategy("def on_bar(c): c.buy(c.qty)\n")
    placed: list[str] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append(side)
        return "X"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()

    assert placed == []
    assert await repo.list_signals(strategy_id=sid) == []  # quiet skip, no spam


async def test_market_hours_bypass_env_overrides(
    db_pool: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.algo import scheduler as sched_mod

    monkeypatch.setenv("ALGO_MARKET_HOURS_BYPASS", "1")
    monkeypatch.setattr(sched_mod, "market_is_open", lambda symbol: False)

    await _make_strategy("def on_bar(c): c.buy(c.qty)\n")
    placed: list[str] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return list(_TWO_BARS_UP)

    async def fake_pos(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append(side)
        return "X"

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_pos, place_paper_order=fake_place
    )
    await sch._tick()
    assert placed == ["BUY"]


async def test_market_is_open_sessions() -> None:
    """Pure session-window checks (UTC inputs; 2026-07-17 is a Friday)."""
    from datetime import timezone

    from app.services.algo.scheduler import market_is_open

    utc = timezone.utc
    # US: 15:00 UTC Friday = 11:00 EDT -> open; 20:30 UTC = 16:30 EDT -> closed.
    assert market_is_open("US.NVDA", datetime(2026, 7, 17, 15, 0, tzinfo=utc))
    assert not market_is_open("US.NVDA", datetime(2026, 7, 17, 20, 30, tzinfo=utc))
    # Saturday -> closed.
    assert not market_is_open("US.NVDA", datetime(2026, 7, 18, 15, 0, tzinfo=utc))
    # HK: 02:00 UTC = 10:00 HKT -> open; 04:30 UTC = 12:30 HKT lunch -> closed.
    assert market_is_open("HK.00700", datetime(2026, 7, 17, 2, 0, tzinfo=utc))
    assert not market_is_open("HK.00700", datetime(2026, 7, 17, 4, 30, tzinfo=utc))
    # Unknown market prefix: never block.
    assert market_is_open("XX.UNKNOWN", datetime(2026, 7, 18, 15, 0, tzinfo=utc))


async def test_bare_sell_flattens_live_position_like_the_backtester(db_pool: Any) -> None:
    """Backtester parity: ``c.sell()`` exits the whole position and an
    explicit qty is capped at what is held. The live path used to resolve a
    bare sell to the entry-sizing default (1 share) and stay exposed."""
    sid = await _make_strategy("def on_bar(c): c.sell()\n")
    placed: list[tuple[str, str, int]] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 90.0)]

    async def fake_position(sym: str) -> int:
        return 10

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return "ORD-S"

    sch = Scheduler(get_klines=fake_klines, get_position=fake_position, place_paper_order=fake_place)
    await sch._tick()
    assert placed == [("US.NVDA", "SELL", 10)]
    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1 and sigs[0].qty == 10


async def test_sell_while_flat_places_nothing(db_pool: Any) -> None:
    sid = await _make_strategy("def on_bar(c): c.sell(3)\n")
    placed: list[tuple[str, str, int]] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 90.0)]

    async def fake_position(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        placed.append((sym, side, qty))
        return "ORD-X"

    sch = Scheduler(get_klines=fake_klines, get_position=fake_position, place_paper_order=fake_place)
    await sch._tick()
    assert placed == []
    sigs = await repo.list_signals(strategy_id=sid)
    assert len(sigs) == 1
    assert sigs[0].order_id is None
    assert "no position" in (sigs[0].error or "")


async def test_account_summary_is_requested_in_the_symbol_currency(db_pool: Any) -> None:
    """Sizing off totals converted into the display currency (MYR) against a
    USD price oversizes several-fold, so the summary is asked for per symbol."""
    await _make_strategy("def on_bar(c): c.buy(c.qty)\n")
    asked: list[str] = []

    async def fake_klines(sym: str, num: int) -> list[Any]:
        return [_bar(datetime(2026, 1, 1), 100.0), _bar(datetime(2026, 1, 2), 110.0)]

    async def fake_position(sym: str) -> int:
        return 0

    async def fake_place(sym: str, side: str, qty: int) -> str:
        return "ORD-1"

    async def fake_summary(sym: str) -> Any:
        asked.append(sym)
        return {"cash": 5_000.0, "total_assets": 5_000.0, "currency": "USD"}

    sch = Scheduler(
        get_klines=fake_klines, get_position=fake_position,
        place_paper_order=fake_place, get_account_summary=fake_summary,
    )
    await sch._tick()
    assert asked == ["US.NVDA"]


# --- SIMULATE invariant ---------------------------------------------------


async def test_place_bridge_hardwires_simulate_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Invariant: the scheduler's only order path (main._make_opend_bridges'
    place_paper_order) must always call the adapter with trd_env=SIMULATE,
    regardless of inputs. The scheduler itself has no trd_env parameter, so
    this bridge is the single seam where live trading could leak in."""
    from app import main as main_mod
    from app.schemas.trade import PlaceOrderResult

    captured: list[dict] = []

    class FakeAdapter:
        def place_order(self, **kwargs: Any) -> PlaceOrderResult:
            captured.append(kwargs)
            return PlaceOrderResult(
                order_id="ORD-SIM",
                code=kwargs["code"],
                side=kwargs["side"],
                qty=kwargs["qty"],
                price=0.0,
                status="SUBMITTED",
                trd_env=kwargs["trd_env"],
                acc_id="1",
            )

    monkeypatch.setattr(main_mod, "_build_adapter", lambda *a, **k: FakeAdapter())
    _, _, _, place = main_mod._make_opend_bridges()
    await place("US.NVDA", "BUY", 1)
    await place("HK.00700", "SELL", 3)

    assert captured
    assert all(call["trd_env"] == "SIMULATE" for call in captured)


async def test_scheduler_module_source_never_mentions_the_live_env() -> None:
    """Grep-proof guard: scheduler.py must not contain the live trd_env
    token at all. If someone threads it in, this fails before review."""
    import inspect

    from app.services.algo import scheduler as sched_mod

    assert "REAL" not in inspect.getsource(sched_mod)
