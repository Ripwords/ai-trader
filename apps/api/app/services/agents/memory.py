"""Postgres-backed reflection recall.

``recall(user_id, symbol, k)`` returns the K most recent reflections for the
(user, symbol) pair, joined with the decision they reflect on. The graph
builder turns these into seed memories for tradingagents'
``FinancialSituationMemory`` so the trader prompt picks them up via the same
BM25 lookup it already runs (see ``apps/api/app/services/agents/graph.py``).

Until Task 9 generates real reflections this returns ``[]`` for every call —
runs are unchanged in the meantime.
"""

from __future__ import annotations

from typing import Any

import asyncpg


_RECALL_SQL = """
SELECT r.text, r.outcome, r.alpha::float AS alpha, d.rating, d.trade_date
FROM agent_reflections r
JOIN agent_decisions d ON d.id = r.decision_id
WHERE d.user_id = $1 AND d.symbol = $2
ORDER BY r.reflected_at DESC
LIMIT $3
"""


class PostgresMemoryProvider:
    """Async wrapper around the reflection recall query."""

    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def recall(
        self, user_id: str, symbol: str, k: int = 5
    ) -> list[dict[str, Any]]:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(_RECALL_SQL, user_id, symbol, k)
        return [dict(r) for r in rows]
