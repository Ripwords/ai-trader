import pytest
from unittest.mock import patch

from app.services.agents.toolkit import build_toolkit, _normalize_moomoo_symbol


def test_normalize_moomoo_symbol_adds_us_prefix_for_bare_ticker():
    """Analysts often emit bare US tickers (``SOFI``) because the prompt
    context doesn't push them toward moomoo's ``MARKET.CODE`` form. Without
    this normalizer, every get_stock_data call would die with
    ``ERROR. format of code SOFI is wrong``."""
    assert _normalize_moomoo_symbol("SOFI") == "US.SOFI"
    assert _normalize_moomoo_symbol("AAPL") == "US.AAPL"


def test_normalize_moomoo_symbol_preserves_existing_prefix():
    """Non-US tickers reach the toolkit pre-prefixed (``HK.00700``); the
    normalizer must NOT clobber them with a ``US.`` redirect."""
    assert _normalize_moomoo_symbol("US.NVDA") == "US.NVDA"
    assert _normalize_moomoo_symbol("HK.00700") == "HK.00700"
    assert _normalize_moomoo_symbol("SZ.000001") == "SZ.000001"


@pytest.mark.asyncio
async def test_get_balance_sheet_calls_internal(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    captured = {}

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["headers"] = headers
        captured["params"] = params

        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {"symbol": "NVDA", "balance_sheet": {"total_assets": 100}}

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_balance_sheet.ainvoke({"symbol": "NVDA"})
    assert "Balance Sheet for NVDA" in result
    assert "total_assets" in result
    assert "/internal/yahoo/balance-sheet" in captured["url"]
    assert captured["headers"]["authorization"] == "Bearer secret"
    assert captured["params"]["symbol"] == "NVDA"


@pytest.mark.asyncio
async def test_get_balance_sheet_handles_empty(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {"symbol": "NVDA", "balance_sheet": None}

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_balance_sheet.ainvoke({"symbol": "NVDA"})
    assert "No balance sheet" in result


@pytest.mark.asyncio
async def test_get_news_handles_search_failure(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {"symbol": "NVDA", "results": [], "error": "no key"}

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_news.ainvoke({"symbol": "NVDA", "date_range": "7d"})
    assert "News search not configured" in result or "no key" in result.lower()
