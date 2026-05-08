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


@pytest.fixture
async def db_pool() -> Any:
    """Real DB pool against the running compose postgres. If no DATABASE_URL
    is set, skip — these tests don't run on CI without the local stack.

    pytest-asyncio gives each test a fresh event loop, so we open AND close
    the pool per-test (asyncpg pools are loop-bound)."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("no DATABASE_URL — algo DB tests need the compose stack")
    pool = await repo.init_pool(url)
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
