from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from app.schemas.fundamentals import FinancialMetrics
from app.services.fundamentals import client as fclient
from app.services.fundamentals.cache import cache


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    cache.clear()


def test_to_yf_symbol_us() -> None:
    assert fclient._to_yf_symbol("US.NVDA") == "NVDA"
    assert fclient._to_yf_symbol("US.AAPL") == "AAPL"


def test_to_yf_symbol_hk_pads_to_four_digits() -> None:
    assert fclient._to_yf_symbol("HK.00700") == "0700.HK"
    assert fclient._to_yf_symbol("HK.0001") == "0001.HK"
    assert fclient._to_yf_symbol("HK.9988") == "9988.HK"


def test_to_yf_symbol_china() -> None:
    assert fclient._to_yf_symbol("SH.600519") == "600519.SS"
    assert fclient._to_yf_symbol("SZ.000001") == "000001.SZ"


def test_to_yf_symbol_passthrough_for_unknown() -> None:
    assert fclient._to_yf_symbol("NVDA") == "NVDA"
    assert fclient._to_yf_symbol("XX.FOO") == "XX.FOO"


def _fake_ticker(info: dict[str, Any]) -> MagicMock:
    t = MagicMock()
    t.info = info
    return t


@pytest.mark.asyncio
async def test_get_financial_metrics_returns_populated_model() -> None:
    info = {
        "marketCap": 3_000_000_000_000,
        "trailingPE": 32.5,
        "priceToBook": 45.1,
        "priceToSalesTrailing12Months": 30.0,
        "trailingEps": 4.2,
        "dividendYield": 0.0003,
        "returnOnEquity": 1.15,
        "returnOnAssets": 0.5,
        "profitMargins": 0.55,
        "operatingMargins": 0.6,
        "revenueGrowth": 0.95,
        "earningsGrowth": 1.5,
        "debtToEquity": 50.0,
        "currentRatio": 4.0,
        "freeCashflow": 56_000_000_000,
        "beta": 1.7,
        "sharesOutstanding": 24_500_000_000,
    }
    with patch.object(fclient, "_get_ticker", return_value=_fake_ticker(info)):
        metrics = await fclient.get_financial_metrics("US.NVDA")
    assert isinstance(metrics, FinancialMetrics)
    assert metrics.symbol == "US.NVDA"
    assert metrics.market_cap == 3_000_000_000_000
    assert metrics.pe_ratio == 32.5
    assert metrics.beta == 1.7
    assert metrics.shares_outstanding == 24_500_000_000


@pytest.mark.asyncio
async def test_get_financial_metrics_handles_missing_fields() -> None:
    with patch.object(fclient, "_get_ticker", return_value=_fake_ticker({})):
        metrics = await fclient.get_financial_metrics("US.NVDA")
    assert metrics.market_cap is None
    assert metrics.pe_ratio is None


@pytest.mark.asyncio
async def test_cache_hit_skips_upstream() -> None:
    info = {"marketCap": 1.0, "trailingPE": 10.0}
    mock_get = MagicMock(return_value=_fake_ticker(info))
    with patch.object(fclient, "_get_ticker", mock_get):
        first = await fclient.get_financial_metrics("US.AAPL")
        second = await fclient.get_financial_metrics("US.AAPL")
    assert mock_get.call_count == 1
    assert first == second


@pytest.mark.asyncio
async def test_cache_misses_for_different_symbols() -> None:
    info = {"marketCap": 1.0}
    mock_get = MagicMock(return_value=_fake_ticker(info))
    with patch.object(fclient, "_get_ticker", mock_get):
        await fclient.get_financial_metrics("US.AAPL")
        await fclient.get_financial_metrics("US.MSFT")
    assert mock_get.call_count == 2


@pytest.mark.asyncio
async def test_get_company_news_normalises_nested_content() -> None:
    ticker = MagicMock()
    ticker.news = [
        {
            "content": {
                "title": "NVDA earnings beat",
                "canonicalUrl": {"url": "https://example.com/nvda"},
                "pubDate": "2026-05-01T12:00:00Z",
            },
        },
        {
            "content": {
                "title": "Old format",
                "link": "https://example.com/old",
                "providerPublishTime": "2026-04-30T08:00:00Z",
            },
        },
    ]
    with patch.object(fclient, "_get_ticker", return_value=ticker):
        items = await fclient.get_company_news("US.NVDA", limit=5)
    assert len(items) == 2
    assert items[0].title == "NVDA earnings beat"
    assert items[0].url == "https://example.com/nvda"
    assert items[1].url == "https://example.com/old"


@pytest.mark.asyncio
async def test_get_fundamentals_bundle_composes_metrics_and_history() -> None:
    info = {"marketCap": 100.0}
    ticker = _fake_ticker(info)
    ticker.financials = None
    ticker.balance_sheet = None
    ticker.cashflow = None
    with patch.object(fclient, "_get_ticker", return_value=ticker):
        bundle = await fclient.get_fundamentals_bundle("US.NVDA")
    assert bundle.metrics.market_cap == 100.0
    assert bundle.history == []
