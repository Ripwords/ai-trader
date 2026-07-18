from unittest.mock import AsyncMock

import pytest

from app.services.agents.cost_cap import DailyCapExceeded, assert_under_daily_cap


@pytest.mark.asyncio
async def test_under_cap_allows():
    db = AsyncMock()
    db.fetchval.return_value = 1.50
    await assert_under_daily_cap(db, user_id="u1", cap_usd=5.00)


@pytest.mark.asyncio
async def test_at_cap_rejects():
    db = AsyncMock()
    db.fetchval.return_value = 5.00
    with pytest.raises(DailyCapExceeded) as exc:
        await assert_under_daily_cap(db, user_id="u1", cap_usd=5.00)
    assert exc.value.spent_usd == 5.00
    assert exc.value.cap_usd == 5.00


@pytest.mark.asyncio
async def test_null_means_zero():
    db = AsyncMock()
    db.fetchval.return_value = None
    await assert_under_daily_cap(db, user_id="u1", cap_usd=5.00)


@pytest.mark.asyncio
async def test_missing_user_id_enforces_global_bucket():
    """No x-user-id must NOT skip the cap. The spend query drops the user
    filter and sums today's runs across all users (the 'global' bucket)."""
    db = AsyncMock()
    db.fetchval.return_value = 6.00
    with pytest.raises(DailyCapExceeded):
        await assert_under_daily_cap(db, user_id=None, cap_usd=5.00)
    call = db.fetchval.call_args
    assert "user_id" not in call.args[0]
    assert len(call.args) == 1  # no bind params for the global query


@pytest.mark.asyncio
async def test_missing_user_id_global_bucket_under_cap_allows():
    db = AsyncMock()
    db.fetchval.return_value = 0.50
    await assert_under_daily_cap(db, user_id=None, cap_usd=5.00)
