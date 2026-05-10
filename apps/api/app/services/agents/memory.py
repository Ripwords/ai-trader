"""Postgres-backed reflection recall — per-role.

``recall_by_role(user_id, symbol, k)`` returns a ``{role: rows}`` map of the
K most recent reflections for each role TradingAgents tracks (``trader``,
``bull_researcher``, ``bear_researcher``, ``invest_judge``,
``risk_manager``, plus ``overall`` for legacy single-row reflections). The
graph builder seeds each role's :class:`FinancialSituationMemory` from its
own slice — bull researcher reads bull lessons, bear reads bear, etc. —
matching TradingAgents' methodology where each role learns from its own
mistakes without contaminating the other prompts.

The legacy ``recall()`` method (single flat list) is kept for callers that
predate the role split.
"""

from __future__ import annotations

from typing import Any

import asyncpg


# Roles the upstream Reflector writes one reflection each per decision.
# ``overall`` is the legacy aggregate role our older reflection job used.
KNOWN_ROLES: tuple[str, ...] = (
    "trader",
    "bull_researcher",
    "bear_researcher",
    "invest_judge",
    "risk_manager",
    "overall",
)


_RECALL_SQL = """
SELECT r.text, r.outcome, r.alpha::float AS alpha, r.role,
       d.rating, d.trade_date
FROM agent_reflections r
JOIN agent_decisions d ON d.id = r.decision_id
WHERE d.user_id = $1 AND d.symbol = $2
ORDER BY r.reflected_at DESC
LIMIT $3
"""


_RECALL_BY_ROLE_SQL = """
SELECT r.text, r.outcome, r.alpha::float AS alpha, r.role,
       d.rating, d.trade_date
FROM agent_reflections r
JOIN agent_decisions d ON d.id = r.decision_id
WHERE d.user_id = $1 AND d.symbol = $2 AND r.role = $3
ORDER BY r.reflected_at DESC
LIMIT $4
"""


class PostgresMemoryProvider:
    """Async wrapper around the per-role reflection recall queries."""

    def __init__(self, pool: asyncpg.Pool):
        self.pool = pool

    async def recall(
        self, user_id: str, symbol: str, k: int = 5
    ) -> list[dict[str, Any]]:
        """Flat list of the K most recent reflections across all roles.

        Kept for callers that don't care about role attribution (e.g. the
        legacy single-list trader memory seed). Newer callers should use
        :meth:`recall_by_role`.
        """
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(_RECALL_SQL, user_id, symbol, k)
        return [dict(r) for r in rows]

    async def recall_by_role(
        self, user_id: str, symbol: str, k: int = 5
    ) -> dict[str, list[dict[str, Any]]]:
        """Return ``{role: rows}`` for every role in :data:`KNOWN_ROLES`.

        Each role is queried independently so a role with very few
        reflections still gets its full top-K (rather than being crowded
        out by another role's volume in a single ORDER BY).
        """
        out: dict[str, list[dict[str, Any]]] = {}
        async with self.pool.acquire() as conn:
            for role in KNOWN_ROLES:
                rows = await conn.fetch(_RECALL_BY_ROLE_SQL, user_id, symbol, role, k)
                out[role] = [dict(r) for r in rows]
        return out
