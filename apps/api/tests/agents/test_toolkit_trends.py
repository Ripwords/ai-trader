"""Data-fidelity tests: multi-period statement trends, honored date ranges,
configurable insider window.

The toolkit proxies to the Nuxt container's ``/api/internal/*`` routes; the
fake HTTP layer here routes by URL suffix so one tool call that fans out to
several internal routes (snapshot + statement-history) gets the right payload
for each.
"""

from datetime import date, timedelta
from unittest.mock import patch

import pytest

from app.services.agents.toolkit import _bars_needed, build_toolkit

ANNUAL_PERIODS = [
    {
        "period": "2025",
        "revenue": 130_497_000_000,
        "net_income": 72_880_000_000,
        "eps": None,
        "fcf": 60_853_000_000,
        "total_debt": 8_460_000_000,
        "total_assets": 111_601_000_000,
        "shareholders_equity": 79_327_000_000,
    },
    {
        "period": "2024",
        "revenue": 60_922_000_000,
        "net_income": 29_760_000_000,
        "eps": None,
        "fcf": 27_021_000_000,
        "total_debt": 9_700_000_000,
        "total_assets": 65_728_000_000,
        "shareholders_equity": 42_978_000_000,
    },
    {
        "period": "2023",
        "revenue": 26_974_000_000,
        "net_income": 4_368_000_000,
        "eps": None,
        "fcf": 3_808_000_000,
        "total_debt": 11_100_000_000,
        "total_assets": 41_182_000_000,
        "shareholders_equity": 22_101_000_000,
    },
]

QUARTERLY_PERIODS = [
    {
        "period": "2026 Q1",
        "end_date": "2026-04-30",
        "revenue": 44_060_000_000,
        "net_income": 18_780_000_000,
        "eps": 0.81,
        "operating_income": 21_640_000_000,
    },
    {
        "period": "2025 Q4",
        "end_date": "2026-01-31",
        "revenue": 39_330_000_000,
        "net_income": 22_090_000_000,
        "eps": 0.89,
        "operating_income": 24_030_000_000,
    },
]


def _fake_http(responses: dict[str, dict], calls: list[dict]):
    """Return an ``httpx.AsyncClient.get`` stand-in that routes by URL suffix."""

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        calls.append({"url": url, "params": params, "headers": headers})
        body: dict = {}
        for suffix, payload in responses.items():
            if url.endswith(suffix):
                body = payload
                break

        class R:
            status_code = 200

            def raise_for_status(self):
                pass

            def json(self):
                return body

        return R()

    return fake_get


@pytest.fixture(autouse=True)
def _internal_env(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")


# ─── statement trends ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_balance_sheet_includes_annual_trend():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/balance-sheet": {
            "symbol": "NVDA",
            "balance_sheet": {"period": "2025", "total_assets": 111_601_000_000},
        },
        "/api/internal/yahoo/statement-history": {
            "symbol": "NVDA",
            "freq": "annual",
            "periods": ANNUAL_PERIODS,
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_balance_sheet.ainvoke({"ticker": "NVDA"})

    assert "Balance Sheet for NVDA" in result
    assert "total_assets" in result  # snapshot still present
    assert "trend" in result.lower()
    # oldest → newest ordering with compact money formatting
    trend = result[result.lower().index("trend"):]
    assert trend.index("2023") < trend.index("2025")
    assert "111.60B" in result
    assert "8.46B" in result
    hist_calls = [c for c in calls if c["url"].endswith("/statement-history")]
    assert hist_calls and hist_calls[0]["params"]["freq"] == "annual"
    assert "quarterly history not available" in result


QUARTERLY_BALANCE = [  # newest first, as the web route returns it
    {"period": "2026 Q1", "end_date": "2026-03-31", "total_assets": 450e9,
     "total_debt": 209.888e9, "cash": 101.816e9, "shareholders_equity": 441.914e9},
    {"period": "2025 Q4", "end_date": "2025-12-31", "total_assets": 400e9,
     "total_debt": 152.987e9, "cash": 86.81e9, "shareholders_equity": 411.065e9},
    {"period": "2025 Q3", "end_date": "2025-09-30", "total_assets": 360e9,
     "total_debt": None, "cash": 66.922e9, "shareholders_equity": 369.631e9},
]


@pytest.mark.asyncio
async def test_get_balance_sheet_includes_quarterly_trend_with_net_debt():
    responses = {
        "/api/internal/yahoo/balance-sheet": {
            "symbol": "AMZN",
            "balance_sheet": {"total_assets": 450e9},
            "quarterly": QUARTERLY_BALANCE,
        },
        "/api/internal/yahoo/statement-history": {"symbol": "AMZN", "periods": ANNUAL_PERIODS},
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, [])):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_balance_sheet.ainvoke({"ticker": "AMZN"})

    q = result[result.index("Quarterly balance-sheet trend"):]
    assert q.index("2025 Q3") < q.index("2026 Q1")  # oldest → newest
    row = next(line for line in q.splitlines() if line.startswith("| 2026 Q1"))
    # net debt = 209.888 − 101.816; debt QoQ = 209.888 / 152.987 − 1
    assert "108.07B" in row
    assert "+37.2%" in row
    assert "0.47" in row  # debt / equity
    q3 = next(line for line in q.splitlines() if line.startswith("| 2025 Q3"))
    assert "n/a" in q3
    # the annual table is still there, and no longer claims quarters are missing
    assert "Annual balance-sheet trend" in result
    assert "not available" not in result


@pytest.mark.asyncio
async def test_get_cashflow_trend_has_yoy_deltas():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/cashflow": {
            "symbol": "NVDA",
            "cashflow": {"period": "2025", "free_cash_flow": 60_853_000_000},
        },
        "/api/internal/yahoo/statement-history": {
            "symbol": "NVDA",
            "freq": "annual",
            "periods": ANNUAL_PERIODS,
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_cashflow.ainvoke({"ticker": "NVDA"})

    assert "Cashflow for NVDA" in result
    assert "60.85B" in result
    # FCF 3.808B → 27.021B is +609.6% YoY
    assert "+609.6%" in result


@pytest.mark.asyncio
async def test_get_income_statement_quarterly_trend():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/income-statement": {
            "symbol": "NVDA",
            "income_statement": {"period": "2025", "revenue": 130_497_000_000},
        },
        "/api/internal/yahoo/statement-history": {
            "symbol": "NVDA",
            "freq": "quarterly",
            "periods": QUARTERLY_PERIODS,
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_income_statement.ainvoke(
            {"ticker": "NVDA", "freq": "quarterly"}
        )

    assert "Income Statement for NVDA" in result
    assert "2026 Q1" in result and "2025 Q4" in result
    assert "44.06B" in result
    assert "0.81" in result  # EPS column
    hist_calls = [c for c in calls if c["url"].endswith("/statement-history")]
    assert hist_calls[0]["params"]["freq"] == "quarterly"
    assert hist_calls[0]["params"]["periods"] == 8


@pytest.mark.asyncio
async def test_income_statement_flags_net_income_above_operating_income():
    # Amazon Q2 2026: net income $62.6B on operating income $27.5B; the gap
    # is non-operating (an investment gain), not the core business.
    periods = [
        {"period": "2026 Q2", "end_date": "2026-06-30", "revenue": 200_606_000_000,
         "net_income": 62_647_000_000, "eps": 5.75, "operating_income": 27_461_000_000},
        {"period": "2026 Q1", "end_date": "2026-03-31", "revenue": 181_519_000_000,
         "net_income": 30_255_000_000, "eps": 2.78, "operating_income": 23_852_000_000},
        {"period": "2025 Q4", "end_date": "2025-12-31", "revenue": 213_386_000_000,
         "net_income": 21_192_000_000, "eps": 1.95, "operating_income": 24_977_000_000},
    ]
    responses = {
        "/api/internal/yahoo/income-statement": {"symbol": "AMZN", "income_statement": None},
        "/api/internal/yahoo/statement-history": {"symbol": "AMZN", "freq": "quarterly", "periods": periods},
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, [])):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_income_statement.ainvoke({"ticker": "AMZN", "freq": "quarterly"})

    assert "Operating Income" in result
    assert "27.46B" in result
    flag = next(line for line in result.splitlines() if "above operating income" in line)
    assert "2026 Q2" in flag and "2026 Q1" in flag
    assert "2025 Q4" not in flag


@pytest.mark.asyncio
async def test_income_statement_shows_yoy_matched_by_date():
    # Retail is seasonal: Q1 always falls from Q4, so QoQ alone reads as a
    # slump. YoY compares with the quarter a year earlier, found by end date.
    def q(period, end, rev):
        return {"period": period, "end_date": end, "revenue": rev, "net_income": None,
                "eps": None, "operating_income": None}
    periods = [
        q("2026 Q1", "2026-03-31", 181_519_000_000),
        q("2025 Q4", "2025-12-31", 213_386_000_000),
        q("2025 Q3", "2025-09-30", 180_169_000_000),
        q("2025 Q1", "2025-03-31", 155_667_000_000),
    ]
    responses = {
        "/api/internal/yahoo/income-statement": {"symbol": "AMZN", "income_statement": None},
        "/api/internal/yahoo/statement-history": {"symbol": "AMZN", "freq": "quarterly", "periods": periods},
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, [])):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_income_statement.ainvoke({"ticker": "AMZN", "freq": "quarterly"})

    header = next(line for line in result.splitlines() if line.startswith("| Quarter"))
    assert "YoY" in header
    q1 = next(line for line in result.splitlines() if line.startswith("| 2026 Q1"))
    cells = [c.strip() for c in q1.strip("|").split("|")]
    assert cells[2] == "-14.9%"  # QoQ vs Q4
    assert cells[3] == "+16.6%"  # YoY vs 2025 Q1
    q4 = next(line for line in result.splitlines() if line.startswith("| 2025 Q4"))
    assert [c.strip() for c in q4.strip("|").split("|")][3] == "—"


@pytest.mark.asyncio
async def test_get_income_statement_annual_trend():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/income-statement": {
            "symbol": "NVDA",
            "income_statement": {"period": "2025", "revenue": 130_497_000_000},
        },
        "/api/internal/yahoo/statement-history": {
            "symbol": "NVDA",
            "freq": "annual",
            "periods": ANNUAL_PERIODS,
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_income_statement.ainvoke(
            {"ticker": "NVDA", "freq": "annual"}
        )

    # Revenue 60.922B → 130.497B is +114.2% YoY
    assert "+114.2%" in result
    hist_calls = [c for c in calls if c["url"].endswith("/statement-history")]
    assert hist_calls[0]["params"]["freq"] == "annual"
    assert hist_calls[0]["params"]["periods"] == 5


@pytest.mark.asyncio
async def test_get_fundamentals_includes_trend_and_cagr():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/fundamentals": {
            "symbol": "NVDA",
            "metrics": {"symbol": "NVDA", "pe_ratio": 50.2, "market_cap": 3_000_000_000_000},
            "history": ANNUAL_PERIODS,
            "balance_sheet": {"period": "2025"},
            "cashflow": {"period": "2025"},
            "income_statement": {"period": "2025"},
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_fundamentals.ainvoke(
            {"ticker": "NVDA", "curr_date": "2026-07-01"}
        )

    assert "Fundamentals for NVDA" in result
    assert "pe_ratio" in result
    assert "CAGR" in result
    # revenue 26.974B → 130.497B over 2 intervals ≈ +120.0%/yr
    assert "+120.0%" in result
    # the raw multi-key history JSON must not be dumped wholesale
    assert '"shareholders_equity"' not in result


@pytest.mark.asyncio
async def test_statement_trend_failure_falls_back_to_snapshot():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/balance-sheet": {
            "symbol": "NVDA",
            "balance_sheet": {"period": "2025", "total_assets": 1},
        },
        # statement-history returns junk (route missing/erroring)
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_balance_sheet.ainvoke({"ticker": "NVDA"})

    assert "Balance Sheet for NVDA" in result
    assert "total_assets" in result


# ─── stock data window ──────────────────────────────────────────────────


def test_bars_needed_scales_with_range_and_caps_at_500():
    today = date(2026, 7, 18)
    # ~78 calendar days back → ceil(78 * 5/7) + 10 = 66
    assert _bars_needed(date(2026, 5, 1), today) == 66
    # short ranges get a floor
    assert _bars_needed(date(2026, 7, 15), today) >= 30
    # multi-year ranges cap
    assert _bars_needed(date(2020, 1, 1), today) == 500


class _RangeOpend:
    """Serves the last ``num`` bars of a daily series ending today."""

    def __init__(self, total_days: int = 600):
        self.captured_num: int | None = None
        today = date.today()
        self.bars = [
            {
                "time": (today - timedelta(days=total_days - 1 - i)).isoformat(),
                "open": 100.0 + i * 0.1,
                "high": 101.0 + i * 0.1,
                "low": 99.0 + i * 0.1,
                "close": 100.0 + i * 0.1,
                "volume": 1_000_000,
            }
            for i in range(total_days)
        ]

    async def get_kline(self, symbol, ktype, num):
        self.captured_num = num
        return self.bars[-num:]


@pytest.mark.asyncio
async def test_get_stock_data_honors_requested_range():
    opend = _RangeOpend()
    today = date.today()
    start = (today - timedelta(days=40)).isoformat()
    end = (today - timedelta(days=10)).isoformat()

    toolkit = build_toolkit(opend_client=opend)
    result = await toolkit.get_stock_data.ainvoke(
        {"symbol": "AAPL", "start_date": start, "end_date": end}
    )

    assert opend.captured_num == _bars_needed(today - timedelta(days=40), today)
    # bars outside the window must not appear
    assert today.isoformat() not in result
    assert (today - timedelta(days=60)).isoformat() not in result
    # bars inside the window do
    assert (today - timedelta(days=20)).isoformat() in result
    assert "downsampled" not in result


@pytest.mark.asyncio
async def test_get_stock_data_downsamples_long_ranges_to_weekly():
    opend = _RangeOpend()
    today = date.today()
    start = (today - timedelta(days=300)).isoformat()
    end = today.isoformat()

    toolkit = build_toolkit(opend_client=opend)
    result = await toolkit.get_stock_data.ainvoke(
        {"symbol": "AAPL", "start_date": start, "end_date": end}
    )

    assert "downsampled to weekly" in result
    data_lines = [line for line in result.splitlines() if line[:4].isdigit()]
    # ~300 calendar days → ~43 weekly bars, far fewer than 120
    assert 20 < len(data_lines) <= 120


@pytest.mark.asyncio
async def test_get_stock_data_invalid_dates_keeps_default_window():
    opend = _RangeOpend()
    toolkit = build_toolkit(opend_client=opend)
    result = await toolkit.get_stock_data.ainvoke(
        {"symbol": "AAPL", "start_date": "n/a", "end_date": "n/a"}
    )
    assert opend.captured_num == 252
    data_lines = [line for line in result.splitlines() if line[:4].isdigit()]
    assert len(data_lines) == 60


# ─── insider window ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_insider_transactions_defaults_to_90_days():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/insider-transactions": {
            "symbol": "NVDA",
            "days": 90,
            "transactions": [],
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_insider_transactions.ainvoke({"ticker": "NVDA"})

    assert calls[0]["params"]["days"] == 90
    assert "last 90 days" in result


@pytest.mark.asyncio
async def test_insider_transactions_days_param_capped_at_365():
    calls: list[dict] = []
    responses = {
        "/api/internal/yahoo/insider-transactions": {
            "symbol": "NVDA",
            "days": 365,
            "transactions": [
                {"date": "2026-01-05", "insider_name": "Doe", "transaction_type": "buy",
                 "shares": 100, "value": 5000},
            ],
        },
    }
    with patch("httpx.AsyncClient.get", new=_fake_http(responses, calls)):
        toolkit = build_toolkit(opend_client=None)
        result = await toolkit.get_insider_transactions.ainvoke(
            {"ticker": "NVDA", "days": 9999}
        )

    assert calls[0]["params"]["days"] == 365
    assert "Doe" in result
