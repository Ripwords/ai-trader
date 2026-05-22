import pytest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.routers.algo import canonicalize_symbol_or_422


@pytest.mark.asyncio
async def test_returns_canonical_moomoo_when_resolved():
    with patch(
        "app.routers.algo.resolve_symbol",
        new=AsyncMock(return_value={"status": "resolved", "moomoo": "US.MU", "name": "Micron"}),
    ):
        assert await canonicalize_symbol_or_422("MU") == "US.MU"


@pytest.mark.asyncio
async def test_rejects_yahoo_only_symbols_without_moomoo_code():
    with patch(
        "app.routers.algo.resolve_symbol",
        new=AsyncMock(
            return_value={
                "status": "resolved",
                "symbol": "0097.KL",
                "moomoo": None,
                "yahoo": "0097.KL",
                "name": "ViTrox Corporation Berhad",
            }
        ),
    ):
        with pytest.raises(HTTPException) as exc:
            await canonicalize_symbol_or_422("0097.KL")
    assert exc.value.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("verdict", [
    {"status": "ambiguous", "candidates": []},
    {"status": "not_found"},
    {"status": "error"},
])
async def test_rejects_unresolved_with_422(verdict):
    """Algo fails closed — a backtest on the wrong instrument is silent
    money-losing wrong, so an unresolved symbol must not persist."""
    with patch("app.routers.algo.resolve_symbol", new=AsyncMock(return_value=verdict)):
        with pytest.raises(HTTPException) as exc:
            await canonicalize_symbol_or_422("MU")
    assert exc.value.status_code == 422
