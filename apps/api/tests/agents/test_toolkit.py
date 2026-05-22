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
async def test_get_indicators_accepts_comma_separated_string():
    """TradingAgents' analyst prompts call get_indicators with a
    comma-separated string of indicators (``"macd,rsi"``). Our shim must
    split + iterate, not pass the joined string to stockstats which would
    error with ``Invalid number of return arguments``."""
    class FakeOpend:
        async def get_kline(self, symbol, ktype, num):
            # 200 days of synthetic OHLCV; enough warmup for SMA / MACD.
            return [
                {"time": f"2026-01-{(i % 28) + 1:02d}",
                 "open": 100 + i * 0.1, "high": 101 + i * 0.1,
                 "low": 99 + i * 0.1, "close": 100 + i * 0.1,
                 "volume": 1_000_000}
                for i in range(200)
            ]

    toolkit = build_toolkit(opend_client=FakeOpend())
    result = await toolkit.get_indicators.ainvoke({
        "symbol": "AAPL",
        "indicator": "rsi,macd",
        "curr_date": "2026-05-10",
        "look_back_days": 60,
    })
    assert "RSI:" in result.upper()
    assert "MACD:" in result.upper()


@pytest.mark.asyncio
async def test_get_indicators_handles_multi_column_indicator():
    """``boll`` returns three columns (boll, boll_ub, boll_lb); the previous
    shim crashed with ``Invalid number of return arguments`` because it
    indexed the joined column name."""
    class FakeOpend:
        async def get_kline(self, symbol, ktype, num):
            return [
                {"time": f"2026-01-{(i % 28) + 1:02d}",
                 "open": 100.0, "high": 101.0, "low": 99.0,
                 "close": 100.0 + (i % 5) * 0.5, "volume": 1_000_000}
                for i in range(200)
            ]

    toolkit = build_toolkit(opend_client=FakeOpend())
    result = await toolkit.get_indicators.ainvoke({
        "symbol": "AAPL",
        "indicator": "boll",
        "curr_date": "2026-05-10",
        "look_back_days": 30,
    })
    # Should NOT contain a stockstats parse error; either a single-column
    # readout (newer stockstats versions return Series) or expanded multi-
    # column lines.
    assert "Invalid" not in result
    assert "BOLL" in result.upper() or "boll" in result.lower()


@pytest.mark.asyncio
async def test_get_stock_data_uses_yahoo_bars_for_non_moomoo_yahoo_ticker(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    class FakeOpend:
        async def get_kline(self, symbol, ktype, num):
            raise AssertionError(f"moomoo should not be called for {symbol}")

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
                return {
                    "symbol": "0097.KL",
                    "bars": [
                        {
                            "time": "2026-05-20",
                            "open": 3.1,
                            "high": 3.2,
                            "low": 3.0,
                            "close": 3.15,
                            "volume": 1000000,
                        }
                    ],
                }

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=FakeOpend())
        result = await toolkit.get_stock_data.ainvoke({
            "symbol": "0097.KL",
            "start_date": "2026-05-01",
            "end_date": "2026-05-20",
        })

    assert captured["url"].endswith("/api/internal/yahoo/daily-bars")
    assert captured["headers"]["authorization"] == "Bearer secret"
    assert captured["params"] == {"symbol": "0097.KL", "limit": 252}
    assert "Daily bars for 0097.KL" in result
    assert "3.15" in result


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
        result = await toolkit.get_balance_sheet.ainvoke({"ticker": "NVDA"})
    assert "Balance Sheet for NVDA" in result
    assert "total_assets" in result
    assert "/api/internal/yahoo/balance-sheet" in captured["url"]
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
        result = await toolkit.get_balance_sheet.ainvoke({"ticker": "NVDA"})
    assert "No balance sheet" in result


@pytest.mark.asyncio
async def test_company_name_anchors_news_query_and_output(monkeypatch):
    """The "US.MU" → "Munich Re" bug: agents only ever saw the ticker. When
    the run carries a resolved company name, the news query and every tool
    output must name the company so the LLM (and the search provider) anchor
    on the right one."""
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    captured = {}

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["params"] = params

        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "symbol": "US.MU",
                    "ticker": [{"title": "micron earnings", "url": "u1", "content": "c"}],
                    "macro": [{"title": "fed holds", "url": "u2", "content": "c"}],
                    "contextual": [{"title": "DRAM prices", "url": "u3", "content": "c"}],
                }

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None, company_name="Micron Technology, Inc.")
        result = await toolkit.get_news.ainvoke(
            {"ticker": "US.MU", "start_date": "2026-05-01", "end_date": "2026-05-10"}
        )

    assert captured["url"].endswith("/api/internal/news/contextual")
    assert "Micron Technology, Inc." in captured["params"]["company"]
    assert captured["params"]["symbol"] == "US.MU"
    assert "Micron Technology, Inc." in result
    assert "Macro" in result and "fed holds" in result


@pytest.mark.asyncio
async def test_get_news_without_company_name_is_unchanged(monkeypatch):
    """No resolved name (legacy/direct callers) → preserve old behaviour:
    query is the bare ticker, output labelled by ticker."""
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    captured = {}

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["params"] = params

        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "symbol": "NVDA",
                    "ticker": [{"title": "x", "url": "u1", "content": "c"}],
                    "macro": [],
                    "contextual": [],
                }

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_news.ainvoke(
            {"ticker": "NVDA", "start_date": "2026-05-01", "end_date": "2026-05-10"}
        )

    assert captured["url"].endswith("/api/internal/news/contextual")
    assert captured["params"]["symbol"] == "NVDA"
    assert "company" not in captured["params"] or not captured["params"]["company"]
    assert "News for NVDA" in result


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
                return {"symbol": "NVDA", "ticker": [], "macro": [], "contextual": [], "error": "no key"}

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_news.ainvoke({"ticker": "NVDA", "start_date": "2026-05-01", "end_date": "2026-05-10"})
    assert result == "News search not configured. Skipping news analysis."


@pytest.mark.asyncio
async def test_get_news_renders_partial_data_with_error_note(monkeypatch):
    """When the API returns some news sections alongside an error (partial
    failure), the tool must render the available sections AND append the
    partial-failure note — it must NOT fall back to the 'not configured'
    short-circuit."""
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return {
                    "symbol": "NVDA",
                    "ticker": [{"title": "nv earnings", "url": "u1", "content": "c"}],
                    "macro": [],
                    "contextual": [],
                    "error": "angle LLM failed",
                }

        return R()

    with patch("httpx.AsyncClient.get", new=fake_get):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_news.ainvoke(
            {"ticker": "NVDA", "start_date": "2026-05-01", "end_date": "2026-05-10"}
        )

    assert "### Ticker" in result
    assert "nv earnings" in result
    assert "News for NVDA" in result
    assert "partially failed" in result and "angle LLM failed" in result
    assert "News search not configured" not in result
