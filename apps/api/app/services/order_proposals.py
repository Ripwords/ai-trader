"""Writes algo signals into the web's approval queue (``order_proposals``).

Drizzle (apps/web) owns the table; this module inserts through the asyncpg
pool ``app.services.algo.repo`` opens at startup, as ``paper_orders`` does.
An algo proposal is always a paper market order for the regular session:
the scheduler trades paper only, and a null ``acc_id`` lets the place call
pick the first paper account when the owner approves it.
"""

from __future__ import annotations

from app.services.algo import repo as algo_repo


async def has_pending_algo_proposal(strategy_id: str, side: str) -> bool:
    """Whether this strategy already has a same-side proposal waiting."""
    async with algo_repo.get_pool().acquire() as conn:
        found = await conn.fetchval(
            """
            SELECT 1 FROM order_proposals
            WHERE algo_strategy_id = $1 AND side = $2
              AND status = 'pending' AND expires_at > now()
            LIMIT 1
            """,
            strategy_id,
            side,
        )
    return found is not None


async def insert_algo_proposal(
    *, strategy_id: str, symbol: str, side: str, qty: int, rationale: str
) -> str:
    """Queue one paper market order for approval; returns the proposal id."""
    async with algo_repo.get_pool().acquire() as conn:
        pid = await conn.fetchval(
            """
            INSERT INTO order_proposals
              (source, algo_strategy_id, acc_id, trd_env, symbol, side, qty,
               order_type, time_in_force, session, rationale)
            VALUES ('algo', $1, NULL, 'SIMULATE', $2, $3, $4,
                    'MARKET', 'DAY', 'RTH', $5)
            RETURNING id
            """,
            strategy_id,
            symbol,
            side,
            qty,
            rationale,
        )
    return str(pid)
