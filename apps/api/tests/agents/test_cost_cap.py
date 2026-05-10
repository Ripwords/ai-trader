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
