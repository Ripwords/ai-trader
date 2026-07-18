"""Async DB access for algo persistence.

Drizzle (Node, in apps/web) owns the schema; this module reads and writes
the same tables via asyncpg. We don't try to mirror the Drizzle types —
we hand-roll the small set of queries the algo surface needs.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import asyncpg
from asyncpg import Pool

from app.schemas.algo import (
    BacktestResult,
    EquityPoint,
    Metrics,
    SignalRecord,
    Strategy,
    StrategyCreate,
    StrategyUpdate,
    TradeRecord,
)

_pool: Pool | None = None


async def init_pool(database_url: str) -> Pool:
    """Create and cache the asyncpg pool. Idempotent."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(database_url, min_size=1, max_size=4)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> Pool:
    if _pool is None:
        raise RuntimeError("DB pool not initialised")
    return _pool


# --- helpers ---------------------------------------------------------------


async def _default_user_id(conn: asyncpg.Connection) -> str:
    """Single-user app — there's exactly one row in users. Create it lazily
    if missing (matches the web app's getOwnerId behaviour)."""
    row = await conn.fetchrow("SELECT id FROM users ORDER BY created_at LIMIT 1")
    if row:
        return str(row["id"])
    new_row = await conn.fetchrow(
        "INSERT INTO users (name) VALUES ('owner') RETURNING id",
    )
    return str(new_row["id"])


def _row_to_strategy(row: asyncpg.Record) -> Strategy:
    return Strategy(
        id=str(row["id"]),
        name=row["name"],
        symbol=row["symbol"],
        cadence=row["cadence"],
        code=row["code"],
        enabled=row["enabled"],
        initial_capital=float(row["initial_capital"]),
        commission_bps=int(row["commission_bps"]),
        slippage_bps=int(row["slippage_bps"]),
        sizing_mode=row["sizing_mode"],
        sizing_value=float(row["sizing_value"]),
        pyramiding_max=int(row["pyramiding_max"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


# --- strategies -----------------------------------------------------------


async def list_strategies() -> list[Strategy]:
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM algo_strategies ORDER BY created_at DESC",
        )
    return [_row_to_strategy(r) for r in rows]


async def get_strategy(strategy_id: str) -> Strategy | None:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM algo_strategies WHERE id = $1",
            strategy_id,
        )
    return _row_to_strategy(row) if row else None


async def create_strategy(body: StrategyCreate) -> Strategy:
    async with get_pool().acquire() as conn:
        owner_id = await _default_user_id(conn)
        row = await conn.fetchrow(
            """
            INSERT INTO algo_strategies
              (user_id, name, symbol, cadence, code,
               initial_capital, commission_bps, slippage_bps,
               sizing_mode, sizing_value, pyramiding_max)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            owner_id,
            body.name,
            body.symbol,
            body.cadence,
            body.code,
            body.initial_capital,
            body.commission_bps,
            body.slippage_bps,
            body.sizing_mode,
            body.sizing_value,
            body.pyramiding_max,
        )
    return _row_to_strategy(row)


async def update_strategy(strategy_id: str, body: StrategyUpdate) -> Strategy | None:
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return await get_strategy(strategy_id)
    set_parts = []
    args: list[Any] = []
    for i, (k, v) in enumerate(fields.items(), start=1):
        set_parts.append(f"{k} = ${i}")
        args.append(v)
    set_parts.append(f"updated_at = now()")
    args.append(strategy_id)
    sql = (
        f"UPDATE algo_strategies SET {', '.join(set_parts)} "
        f"WHERE id = ${len(args)} RETURNING *"
    )
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(sql, *args)
    return _row_to_strategy(row) if row else None


async def delete_strategy(strategy_id: str) -> bool:
    async with get_pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM algo_strategies WHERE id = $1",
            strategy_id,
        )
    return result.endswith("1")


async def list_enabled_strategy_ids() -> list[str]:
    async with get_pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id FROM algo_strategies WHERE enabled = true",
        )
    return [str(r["id"]) for r in rows]


# --- runs -----------------------------------------------------------------


async def create_run(strategy_id: str, kind: str) -> str:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO algo_runs (strategy_id, kind, status)
            VALUES ($1, $2, 'running')
            RETURNING id
            """,
            strategy_id,
            kind,
        )
    return str(row["id"])


async def finalise_run(run_id: str, result: BacktestResult) -> None:
    """Persist backtest results onto the run row."""
    async with get_pool().acquire() as conn:
        await conn.execute(
            """
            UPDATE algo_runs
            SET status = $1,
                equity_curve = $2,
                benchmark_curve = $3,
                price_bars = $4,
                trades = $5,
                metrics = $6,
                error = $7,
                finished_at = now()
            WHERE id = $8
            """,
            result.status,
            json.dumps([p.model_dump(mode="json") for p in result.equity_curve]),
            json.dumps([p.model_dump(mode="json") for p in result.benchmark_curve]),
            json.dumps([b.model_dump(mode="json") for b in result.price_bars]),
            json.dumps([t.model_dump(mode="json") for t in result.trades]),
            json.dumps(result.metrics.model_dump()) if result.metrics else None,
            result.error,
            run_id,
        )


async def get_run(run_id: str) -> BacktestResult | None:
    from app.schemas.quote import Bar

    async with get_pool().acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM algo_runs WHERE id = $1", run_id)
    if not row:
        return None

    def _load_json(raw: Any) -> list[Any]:
        return json.loads(raw) if isinstance(raw, str) else (raw or [])

    eq = _load_json(row["equity_curve"])
    bench = _load_json(row["benchmark_curve"])
    price_raw = _load_json(row["price_bars"])
    tr = _load_json(row["trades"])
    mt_raw = row["metrics"]
    mt = json.loads(mt_raw) if isinstance(mt_raw, str) else mt_raw
    return BacktestResult(
        run_id=str(row["id"]),
        status=row["status"],
        equity_curve=[EquityPoint(**p) for p in eq],
        benchmark_curve=[EquityPoint(**p) for p in bench],
        price_bars=[Bar(**b) for b in price_raw],
        trades=[TradeRecord(**t) for t in tr],
        metrics=Metrics(**mt) if mt else None,
        error=row["error"],
    )


# --- signals --------------------------------------------------------------


async def append_signal(
    strategy_id: str,
    ts: datetime,
    side: str,
    qty: int,
    price: float | None,
    order_id: str | None,
    error: str | None,
) -> SignalRecord:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO algo_signals
              (strategy_id, ts, side, qty, price, order_id, error)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            strategy_id,
            ts,
            side,
            qty,
            price,
            order_id,
            error,
        )
    return SignalRecord(
        id=row["id"],
        strategy_id=str(row["strategy_id"]),
        ts=row["ts"],
        side=row["side"],
        qty=row["qty"],
        price=float(row["price"]) if row["price"] is not None else None,
        order_id=row["order_id"],
        error=row["error"],
    )


async def count_orders_today(strategy_id: str) -> int:
    """Number of signals that actually became orders (order_id set) since
    UTC midnight. Feeds the scheduler's max-orders-per-day guard; blocked
    and errored signals (order_id NULL) don't count. `ts` is stored as a
    naive UTC timestamp, matching `now() AT TIME ZONE 'UTC'`."""
    async with get_pool().acquire() as conn:
        val = await conn.fetchval(
            """
            SELECT count(*) FROM algo_signals
            WHERE strategy_id = $1
              AND order_id IS NOT NULL
              AND ts >= date_trunc('day', now() AT TIME ZONE 'UTC')
            """,
            strategy_id,
        )
    return int(val or 0)


async def list_signals(
    strategy_id: str | None = None, limit: int = 50
) -> list[SignalRecord]:
    async with get_pool().acquire() as conn:
        if strategy_id:
            rows = await conn.fetch(
                "SELECT * FROM algo_signals WHERE strategy_id = $1 "
                "ORDER BY ts DESC LIMIT $2",
                strategy_id,
                limit,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM algo_signals ORDER BY ts DESC LIMIT $1",
                limit,
            )
    return [
        SignalRecord(
            id=r["id"],
            strategy_id=str(r["strategy_id"]),
            ts=r["ts"],
            side=r["side"],
            qty=r["qty"],
            price=float(r["price"]) if r["price"] is not None else None,
            order_id=r["order_id"],
            error=r["error"],
        )
        for r in rows
    ]


# --- kill switch (app_settings.algo_kill_active) --------------------------


async def get_kill_active() -> bool:
    async with get_pool().acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM app_settings WHERE key = 'algo_kill_active'",
        )
    if not row:
        return False
    val = row["value"]
    if isinstance(val, str):
        val = json.loads(val)
    return bool(val)


async def set_kill_active(active: bool) -> None:
    async with get_pool().acquire() as conn:
        await conn.execute(
            """
            INSERT INTO app_settings (key, value, updated_at)
            VALUES ('algo_kill_active', $1::jsonb, now())
            ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value, updated_at = now()
            """,
            json.dumps(active),
        )
