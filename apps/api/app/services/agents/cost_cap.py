from __future__ import annotations

from typing import Protocol


class DBExec(Protocol):
    async def fetchval(self, query: str, *args) -> float | None: ...


class DailyCapExceeded(Exception):
    def __init__(self, spent_usd: float, cap_usd: float):
        super().__init__(f"daily cap exceeded: ${spent_usd:.2f} >= ${cap_usd:.2f}")
        self.spent_usd = spent_usd
        self.cap_usd = cap_usd


_QUERY = """
SELECT COALESCE(SUM(cost_usd), 0)::float
FROM agent_runs
WHERE user_id = $1
  AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
"""

# "Global" bucket: no user filter — sums today's spend across ALL runs.
# Used when the caller didn't forward an x-user-id; enforcing against the
# whole day's spend is fail-closed (strictly tighter than any per-user sum).
_QUERY_GLOBAL = """
SELECT COALESCE(SUM(cost_usd), 0)::float
FROM agent_runs
WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
"""


async def assert_under_daily_cap(
    db: DBExec, user_id: str | None, cap_usd: float
) -> None:
    """Raise :class:`DailyCapExceeded` when today's spend is at/over the cap.

    ``user_id=None`` (or empty) enforces against the global bucket instead of
    skipping the check — a missing user id must never disable the cap.
    """
    if user_id:
        spent = await db.fetchval(_QUERY, user_id) or 0.0
    else:
        spent = await db.fetchval(_QUERY_GLOBAL) or 0.0
    if spent >= cap_usd:
        raise DailyCapExceeded(spent_usd=float(spent), cap_usd=cap_usd)
