"""Best-effort writer for the ``paper_orders`` ledger (api side).

Drizzle (apps/web) owns the schema; this module inserts rows via asyncpg,
reusing the pool ``app.services.algo.repo`` opens at startup. Call sites sit
on the critical path of a live order placement, so :func:`record_paper_order`
NEVER raises — a ledger failure is logged and swallowed, and the order result
is returned to the caller untouched.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.algo import repo as algo_repo


async def record_paper_order(
    *,
    source: str,
    symbol: str,
    side: str,
    qty: int,
    moomoo_order_id: str | None = None,
    acc_id: str | None = None,
    price: float | None = None,
    order_type: str | None = None,
    trd_env: str = "SIMULATE",
    status: str | None = None,
    decision_id: str | None = None,
    raw: dict[str, Any] | None = None,
) -> bool:
    """Insert one ledger row. Returns whether the write happened."""
    try:
        pool = algo_repo.get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO paper_orders
                  (source, decision_id, moomoo_order_id, acc_id, symbol, side, qty,
                   price, order_type, trd_env, status, raw)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                """,
                source,
                decision_id,
                moomoo_order_id,
                acc_id,
                symbol,
                side,
                qty,
                price,
                order_type,
                trd_env,
                status,
                json.dumps(raw) if raw is not None else None,
            )
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[paper-orders] ledger insert failed (order unaffected): {exc}")
        return False
