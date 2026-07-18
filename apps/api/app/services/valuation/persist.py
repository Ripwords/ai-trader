"""Best-effort writer for the ``valuation_snapshots`` table (api side).

Drizzle (apps/web) owns the schema; this module inserts rows via asyncpg,
reusing the pool ``app.services.algo.repo`` opens at startup. Call sites sit
on the response path of ``GET /valuation``, inside the agent-run pipeline,
and in the screener sweep — so :func:`record_valuation_snapshot` NEVER
raises. A snapshot failure is logged and swallowed, and the valuation result
is returned to the caller untouched.
"""

from __future__ import annotations

from typing import Literal

from app.services.algo import repo as algo_repo
from app.services.valuation.models import ValuationResult

SnapshotSource = Literal["chat", "agent_run", "screener"]


async def record_valuation_snapshot(
    result: ValuationResult,
    *,
    source: SnapshotSource,
    run_id: str | None = None,
) -> bool:
    """Insert one snapshot row. Returns whether the write happened."""
    try:
        import json

        pool = algo_repo.get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO valuation_snapshots
                  (symbol, source, run_id, fair_value, current_price,
                   margin_of_safety_pct, data_quality, veto_triggered, result)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                result.symbol,
                source,
                run_id,
                result.fair_value,
                result.current_price,
                result.margin_of_safety_pct,
                result.data_quality,
                result.veto.triggered,
                json.dumps(result.model_dump(mode="json")),
            )
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[valuation-snapshots] insert failed (valuation unaffected): {exc}")
        return False
