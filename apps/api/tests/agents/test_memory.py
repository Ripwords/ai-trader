"""Tests for the Postgres-backed memory provider.

The provider exposes ``recall(user_id, symbol, k)`` which returns past
reflections for the (user, symbol) pair, ordered by ``reflected_at`` desc.
Until Task 9 generates real reflections this just returns ``[]`` in
production — these tests seed rows directly to validate ordering and limits.

Each ``agent_reflections`` row has a UNIQUE constraint on ``decision_id``
(one reflection per decision), so each fixture row gets its own decision.
"""

from __future__ import annotations

import pytest

from app.services.agents.memory import PostgresMemoryProvider


async def _seed_reflection(
    conn,
    user_id: str,
    symbol: str,
    age_days: int,
    text: str,
    rating: str = "buy",
    outcome: str = "correct",
) -> None:
    """Insert one (run, decision, reflection) chain ``age_days`` ago."""
    run_id = await conn.fetchval(
        "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status) "
        "VALUES($1, $2, current_date, '{}'::jsonb, 'complete') RETURNING id",
        user_id,
        symbol,
    )
    decision_id = await conn.fetchval(
        "INSERT INTO agent_decisions(run_id, user_id, symbol, trade_date, "
        "rating, confidence, rationale) "
        "VALUES($1, $2, $3, current_date, $4, 70, 'r') RETURNING id",
        run_id,
        user_id,
        symbol,
        rating,
    )
    await conn.execute(
        "INSERT INTO agent_reflections"
        "(id, decision_id, reflected_at, horizon_days, realized_return, "
        "benchmark_return, alpha, outcome, text) "
        "VALUES(gen_random_uuid(), $1, now() - ($2 || ' days')::interval, "
        "7, 1.0, 0.5, 0.5, $3, $4)",
        decision_id,
        str(age_days),
        outcome,
        text,
    )


@pytest.mark.asyncio
async def test_recall_orders_by_recency(pg_pool):
    user_id = "00000000-0000-0000-0000-000000000001"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'owner') ON CONFLICT DO NOTHING",
            user_id,
        )
        for i, days in enumerate([20, 5, 10]):
            await _seed_reflection(conn, user_id, "NVDA", days, f"reflection-{i}")

    provider = PostgresMemoryProvider(pg_pool)
    rows = await provider.recall(user_id=user_id, symbol="NVDA", k=5)
    # Ordered by reflected_at desc — i=1 (5d ago), i=2 (10d), i=0 (20d).
    assert [r["text"] for r in rows] == ["reflection-1", "reflection-2", "reflection-0"]


@pytest.mark.asyncio
async def test_recall_empty_for_unknown_symbol(pg_pool):
    provider = PostgresMemoryProvider(pg_pool)
    rows = await provider.recall(
        user_id="00000000-0000-0000-0000-000000000099",
        symbol="XYZ",
        k=5,
    )
    assert rows == []


@pytest.mark.asyncio
async def test_recall_respects_k(pg_pool):
    user_id = "00000000-0000-0000-0000-000000000002"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'second') ON CONFLICT DO NOTHING",
            user_id,
        )
        for i in range(3):
            await _seed_reflection(
                conn, user_id, "TSLA", i + 1, f"r{i}", rating="sell", outcome="neutral"
            )

    provider = PostgresMemoryProvider(pg_pool)
    rows = await provider.recall(user_id=user_id, symbol="TSLA", k=2)
    assert len(rows) == 2
