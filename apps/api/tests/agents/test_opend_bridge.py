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

    with patch("app.main._build_adapter", autospec=True, return_value=_FakeAdapter()):
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

    with patch("app.main._build_adapter", autospec=True, return_value=_FakeAdapter()) as build_adapter:
        client = _AgentsOpenDClient(
            host="127.0.0.1",
            port=11111,
            rsa_key_path="/tmp/futu_rsa.key",
        )
        await client.get_kline("US.AAPL", "K_DAY", 30)

    build_adapter.assert_called_once_with("127.0.0.1", 11111, "/tmp/futu_rsa.key", "MYR")


@pytest.mark.asyncio
async def test_algo_opend_bridges_pass_rsa_key_path_to_adapter(monkeypatch) -> None:
    """The algo scheduler bridges use the same lazy adapter path and need the
    configured RSA key too."""

    monkeypatch.setenv("OPEND_HOST", "opend.test")
    monkeypatch.setenv("OPEND_PORT", "22222")
    monkeypatch.setenv("OPEND_RSA_KEY_PATH", "/tmp/futu_rsa.key")
    monkeypatch.setenv("MOOMOO_REPORT_CURRENCY", "SGD")
    get_settings.cache_clear()

    class _FakeKline:
        bars: list[object] = []

    class _FakeAdapter:
        def get_kline(self, *, code: str, ktype: str, num: int):
            return _FakeKline()

    try:
        with patch("app.main._build_adapter", autospec=True, return_value=_FakeAdapter()) as build_adapter:
            get_klines, _, _, _ = _make_opend_bridges()
            assert await get_klines("US.AAPL", 30) == []

        build_adapter.assert_called_once_with("opend.test", 22222, "/tmp/futu_rsa.key", "SGD")
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

    with patch("app.main._build_adapter", autospec=True, return_value=_FakeAdapter()):
        client = _AgentsOpenDClient(host="127.0.0.1", port=11111)
        await client.get_kline("US.SPY", "1d", 10)

    assert captured["ktype"] == "1d"


@pytest.mark.asyncio
async def test_account_summary_raises_when_no_paper_account_is_readable(monkeypatch) -> None:
    """Zeros would make the scheduler size every order to 1 share; raising
    lets it fall back to the strategy's configured capital instead."""
    class _Broken:
        def list_accounts(self):
            return []

    with patch("app.main._build_adapter", autospec=True, return_value=_Broken()):
        _, _, get_account_summary, _ = _make_opend_bridges()
        with pytest.raises(RuntimeError, match="no readable moomoo paper account"):
            await get_account_summary("US.NVDA")


@pytest.mark.asyncio
async def test_bridges_construct_the_real_adapter_with_the_report_currency(monkeypatch) -> None:
    """Regression: the bridges once called ``_build_adapter`` with three
    positional args after it grew a fourth (``report_currency``), so every
    scheduler tick and every agents kline fetch raised TypeError. Tests that
    patched ``_build_adapter`` outright never saw it. Here the real
    ``_build_adapter`` runs; only the OpendAdapter constructor is faked."""
    from app import deps as deps_mod

    monkeypatch.setenv("OPEND_HOST", "opend.test")
    monkeypatch.setenv("OPEND_PORT", "22222")
    monkeypatch.setenv("OPEND_RSA_KEY_PATH", "/tmp/futu_rsa.key")
    monkeypatch.setenv("MOOMOO_REPORT_CURRENCY", "SGD")
    get_settings.cache_clear()
    deps_mod._build_adapter.cache_clear()

    constructed: list[dict[str, object]] = []

    class _FakeKline:
        bars: list[object] = []

    portfolio_calls: list[dict[str, object]] = []

    class _FakeAccount:
        acc_id = "1"
        trd_env = "SIMULATE"

    class _FakePortfolio:
        cash = 1000.0
        total_assets = 5000.0
        currency = "HKD"

    class _FakeOpendAdapter:
        def __init__(self, **kwargs: object) -> None:
            constructed.append(kwargs)

        def get_kline(self, *, code: str, ktype: str, num: int):
            return _FakeKline()

        def list_accounts(self):
            return [_FakeAccount()]

        def get_portfolio(self, **kwargs: object):
            portfolio_calls.append(kwargs)
            return _FakePortfolio()

    monkeypatch.setattr(deps_mod, "OpendAdapter", _FakeOpendAdapter)
    try:
        get_klines, _, get_account_summary, _ = _make_opend_bridges()
        assert await get_klines("US.AAPL", 30) == []
        summary = await get_account_summary("HK.00700")
        assert summary == {"cash": 1000.0, "total_assets": 5000.0, "currency": "HKD"}
        assert portfolio_calls == [{"acc_id": "1", "trd_env": "SIMULATE", "currency": "HKD"}]
        settings = get_settings()
        agents = _AgentsOpenDClient(
            settings.OPEND_HOST,
            settings.OPEND_PORT,
            settings.OPEND_RSA_KEY_PATH,
            settings.MOOMOO_REPORT_CURRENCY,
        )
        assert (await agents.get_kline("US.AAPL", "K_DAY", 30)).bars == []
    finally:
        get_settings.cache_clear()
        deps_mod._build_adapter.cache_clear()

    assert constructed
    assert all(
        c == {"host": "opend.test", "port": 22222, "rsa_key_path": "/tmp/futu_rsa.key", "report_currency": "SGD"}
        for c in constructed
    )
