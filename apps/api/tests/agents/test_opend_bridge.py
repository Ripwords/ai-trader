"""Tests for the agents OpenD bridge wired in lifespan.

The bridge translates SDK-style ktype strings (``K_DAY``) the toolkit and
reflection use into the adapter's native ``1d``-style, and routes the sync
adapter call through ``asyncio.to_thread``. Without this bridge,
``app.state.opend_client`` would be ``None`` and every market-data tool call
would degrade to "Market data unavailable".
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.main import _AGENTS_KTYPE_MAP, _AgentsOpenDClient, _make_opend_bridges
from app.settings import get_settings


def test_ktype_map_covers_sdk_style_keys() -> None:
    """Spot-check the ktype translation table — the toolkit calls with
    ``K_DAY`` (the moomoo SDK constant), the adapter wants ``1d``."""
    assert _AGENTS_KTYPE_MAP["K_DAY"] == "1d"
    assert _AGENTS_KTYPE_MAP["K_WEEK"] == "1w"
    assert _AGENTS_KTYPE_MAP["K_MON"] == "1M"


@pytest.mark.asyncio
async def test_get_kline_translates_ktype_and_routes_to_thread() -> None:
    """Production sync adapter is invoked via ``asyncio.to_thread`` with the
    translated ktype, and ``code=ticker`` (the adapter is keyword-only)."""
    captured: dict[str, object] = {}

    class _FakeAdapter:
        def get_kline(self, *, code: str, ktype: str, num: int):
            captured["code"] = code
            captured["ktype"] = ktype
            captured["num"] = num
            return {"bars": []}

    with patch("app.main._build_adapter", return_value=_FakeAdapter()):
        client = _AgentsOpenDClient(host="127.0.0.1", port=11111)
        result = await client.get_kline("US.AAPL", "K_DAY", 30)

    assert captured == {"code": "US.AAPL", "ktype": "1d", "num": 30}
    assert result == {"bars": []}


@pytest.mark.asyncio
async def test_get_kline_passes_rsa_key_path_to_adapter() -> None:
    """The agents bridge must preserve RSA config; otherwise live/trade-capable
    OpenD connections work through quote routes but fail through agents."""

    class _FakeAdapter:
        def get_kline(self, *, code: str, ktype: str, num: int):
            return {"bars": []}

    with patch("app.main._build_adapter", return_value=_FakeAdapter()) as build_adapter:
        client = _AgentsOpenDClient(
            host="127.0.0.1",
            port=11111,
            rsa_key_path="/tmp/futu_rsa.key",
        )
        await client.get_kline("US.AAPL", "K_DAY", 30)

    build_adapter.assert_called_once_with("127.0.0.1", 11111, "/tmp/futu_rsa.key")


@pytest.mark.asyncio
async def test_algo_opend_bridges_pass_rsa_key_path_to_adapter(monkeypatch) -> None:
    """The algo scheduler bridges use the same lazy adapter path and need the
    configured RSA key too."""

    monkeypatch.setenv("OPEND_HOST", "opend.test")
    monkeypatch.setenv("OPEND_PORT", "22222")
    monkeypatch.setenv("OPEND_RSA_KEY_PATH", "/tmp/futu_rsa.key")
    get_settings.cache_clear()

    class _FakeKline:
        bars: list[object] = []

    class _FakeAdapter:
        def get_kline(self, *, code: str, ktype: str, num: int):
            return _FakeKline()

    try:
        with patch("app.main._build_adapter", return_value=_FakeAdapter()) as build_adapter:
            get_klines, _, _, _ = _make_opend_bridges()
            assert await get_klines("US.AAPL", 30) == []

        build_adapter.assert_called_once_with("opend.test", 22222, "/tmp/futu_rsa.key")
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_get_kline_passes_through_unknown_ktype() -> None:
    """If a caller already uses adapter-style (``1d``) it passes through
    unchanged — the bridge isn't restrictive about ktype values."""
    captured: dict[str, object] = {}

    class _FakeAdapter:
        def get_kline(self, *, code: str, ktype: str, num: int):
            captured["ktype"] = ktype
            return {"bars": []}

    with patch("app.main._build_adapter", return_value=_FakeAdapter()):
        client = _AgentsOpenDClient(host="127.0.0.1", port=11111)
        await client.get_kline("US.SPY", "1d", 10)

    assert captured["ktype"] == "1d"
