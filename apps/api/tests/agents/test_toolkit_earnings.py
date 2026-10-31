"""Earnings-explainer tools: the company's own release, consensus surprise,
and a cash-flow view that shows FCF = OCF − capex per labelled period.

Motivated by an AMZN Q3 2026 debate that concluded SELL on surface numbers:
an EPS "miss" driven by a prior-year Anthropic gain, two conflicting FCF
figures (+3.22B Yahoo levered vs −42.4B company-reported), and no segment or
guidance context.
"""

from dataclasses import fields
from unittest.mock import patch

import httpx
import pytest

from app.services.agents.toolkit import AgentToolkit, build_toolkit


@pytest.fixture(autouse=True)
def _internal_env(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")


def _fake_http(responses: dict[str, object], calls: list[dict]):
    """Route by URL suffix; an ``int`` payload is returned as that HTTP error."""

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        calls.append({"url": url, "params": params})
        body: object = {}
        for suffix, payload in responses.items():
            if url.endswith(suffix):
                body = payload
                break
        status = body if isinstance(body, int) else 200

        class R:
            status_code = status

            def raise_for_status(self):
                if status >= 400:
                    req = httpx.Request("GET", url)
                    raise httpx.HTTPStatusError("err", request=req, response=httpx.Response(status, request=req))

            def json(self):
                return body

        return R()

    return fake_get


RELEASE = {
    "status": "ok",
    "ticker": "AMZN",
    "company": "AMAZON COM INC",
    "cik": "0001018724",
    "form": "8-K",
    "filing_date": "2026-10-29",
    "report_date": "2026-10-29",
    "accession": "0001018724-26-000038",
    "filing_index_url": "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000038/0001018724-26-000038-index.html",
    "exhibit_url": "https://www.sec.gov/Archives/edgar/data/1018724/000101872426000038/amzn-20260930xex991.htm",
    "text": "AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS\n• AWS segment sales increased 39% to $46.0 billion.",
    "chars_total": 43000,
    "truncated": True,
    "omitted": ["Forward-Looking Statements"],
}


def test_toolkit_has_thirteen_tools_including_the_earnings_set():
    names = {f.name for f in fields(AgentToolkit)}
    assert len(names) == 13
    assert {"get_earnings_release", "get_earnings_surprise"} <= names


@pytest.mark.asyncio
async def test_earnings_release_returns_text_with_sec_source_urls():
    calls: list[dict] = []
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/sec/earnings-release": RELEASE}, calls)):
        out = await build_toolkit(None).get_earnings_release.ainvoke({"ticker": "US.AMZN"})
    assert calls[0]["params"] == {"symbol": "US.AMZN"}
    assert "AWS segment sales increased 39%" in out
    assert "Filed: 2026-10-29" in out
    assert RELEASE["exhibit_url"] in out
    assert RELEASE["filing_index_url"] in out
    assert "Forward-Looking Statements" in out  # omitted sections are named


@pytest.mark.asyncio
async def test_earnings_release_not_found_is_explained_not_raised():
    body = {"status": "not_found", "ticker": "HK.00700", "reason": "not a US SEC filer"}
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/sec/earnings-release": body}, [])):
        out = await build_toolkit(None).get_earnings_release.ainvoke({"ticker": "HK.00700"})
    assert "not a US SEC filer" in out
    assert "get_news" in out


@pytest.mark.asyncio
async def test_earnings_release_upstream_error_fails_soft():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/sec/earnings-release": 502}, [])):
        out = await build_toolkit(None).get_earnings_release.ainvoke({"ticker": "AMZN"})
    assert "unavailable" in out.lower()


SURPRISE = {
    "symbol": "AMZN",
    "source": "Yahoo Finance consensus (quoteSummary earningsHistory, earnings, earningsTrend, calendarEvents)",
    "quarters": [
        {"fiscal_quarter": "2Q2026", "period_end": "2026-06-30", "reported_date": "2026-07-30", "days_since_report": 93,
         "eps_estimate": 1.8246, "eps_actual": 5.75, "eps_surprise_pct": 215.14, "revenue_actual": 167_700_000_000, "revenue_estimate": None},
        {"fiscal_quarter": "3Q2026", "period_end": "2026-09-30", "reported_date": "2026-10-29", "days_since_report": 2,
         "eps_estimate": 1.95787, "eps_actual": 1.89, "eps_surprise_pct": -3.47, "revenue_actual": 201_944_000_000, "revenue_estimate": None},
    ],
    "latest": None,
    "next_quarter": {
        "period": "0q", "period_end": "2026-12-31", "eps_avg": 2.44273, "eps_low": 2.18, "eps_high": 2.67,
        "year_ago_eps": 1.95, "analysts": 39, "revenue_avg": 244_313_309_730, "revenue_low": 240e9, "revenue_high": 247.611e9,
        "year_ago_revenue": 213_386_000_000, "revenue_growth": 0.1449,
        "eps_trend": {"current": 2.44273, "d7": 2.44778, "d30": 2.43431, "d60": 2.44025, "d90": 2.43411},
        "revisions": {"up_7d": 1, "up_30d": 2, "down_7d": 0, "down_30d": 1},
    },
    "current_year": None,
    "next_earnings_date": None,
    "notes": ["Yahoo does not keep the pre-report revenue consensus for past quarters."],
}


@pytest.mark.asyncio
async def test_earnings_surprise_table_and_forward_consensus():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/yahoo/earnings-surprise": SURPRISE}, [])):
        out = await build_toolkit(None).get_earnings_surprise.ainvoke({"ticker": "AMZN"})
    assert "Source: Yahoo Finance consensus" in out
    assert "| 3Q2026 | 2026-10-29 | 1.96 | 1.89 | -3.47% | 201.94B |" in out
    assert "+215.14%" in out
    assert "reported 2 days ago" in out
    assert "244.31B" in out  # next-quarter revenue consensus
    assert "39 analysts" in out
    assert "revenue consensus" in out


def _row(end, ocf, capex):
    return {"period_end": end, "label": f"quarter ended {end}", "operating_cash_flow": ocf, "capex": capex, "fcf": ocf - capex}


CASHFLOW = {
    "symbol": "AMZN",
    "cashflow": {"period": "2025", "free_cash_flow": None},
    "yahoo_levered_fcf": {"value": 3_219_124_992, "definition": "Yahoo Finance financialData.freeCashflow: a levered free cash flow estimate"},
    "series": {
        "symbol": "AMZN",
        "source": "SEC EDGAR XBRL company facts (10-Q/10-K)",
        "definition": "FCF = operating cash flow − capital expenditures (purchases of property and equipment)",
        "quarterly": [
            _row("2024-12-31", 45.6e9, 27.8e9), _row("2025-03-31", 17.0e9, 25.0e9),
            _row("2025-06-30", 32.5e9, 32.2e9), _row("2025-09-30", 35.525e9, 35.095e9),
            _row("2025-12-31", 54.5e9, 39.3e9), _row("2026-03-31", 26.032e9, 44.203e9),
            _row("2026-06-30", 45.346e9, 54.43e9), _row("2026-09-30", 42.422e9, 77.259e9),
        ],
        "ttm": {"period_end": "2026-09-30", "label": "TTM to 2026-09-30", "operating_cash_flow": 168.3e9, "capex": 215.192e9, "fcf": -46.892e9},
        "annual": [{"period_end": "2025-12-31", "label": "fiscal year ended 2025-12-31", "operating_cash_flow": 139.514e9, "capex": 131.819e9, "fcf": 7.695e9}],
        "notes": ["Capex is the us-gaap PaymentsToAcquireProductiveAssets line."],
        "source_urls": ["https://data.sec.gov/api/xbrl/companyconcept/CIK0001018724/us-gaap/NetCashProvidedByUsedInOperatingActivities.json"],
    },
}


@pytest.mark.asyncio
async def test_cashflow_shows_fcf_as_ocf_minus_capex_per_labelled_quarter():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/yahoo/cashflow": CASHFLOW}, [])):
        out = await build_toolkit(None).get_cashflow.ainvoke({"ticker": "AMZN"})
    assert "FCF = operating cash flow − capital expenditures" in out
    assert "| quarter ended 2026-09-30 | 42.42B | 77.26B | 42.42B − 77.26B = -34.84B |" in out
    assert "TTM to 2026-09-30: OCF 168.30B − capex 215.19B = FCF -46.89B" in out
    # prior TTM (4 quarters to 2025-09-30): OCF 130.625B, capex 120.095B
    assert "prior TTM to 2025-09-30" in out
    assert "OCF +28.8%" in out
    assert "fiscal year ended 2025-12-31" in out
    assert "Source: SEC EDGAR XBRL" in out
    assert "data.sec.gov" in out


@pytest.mark.asyncio
async def test_cashflow_labels_the_other_fcf_figures_as_not_interchangeable():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/yahoo/cashflow": CASHFLOW}, [])):
        out = await build_toolkit(None).get_cashflow.ainvoke({"ticker": "AMZN"})
    assert "not interchangeable" in out
    assert "Yahoo levered FCF: 3.22B" in out
    assert "proceeds" in out  # company-reported FCF may net asset-sale proceeds / incentives


@pytest.mark.asyncio
async def test_fundamentals_labels_yahoo_free_cash_flow_as_levered():
    body = {"symbol": "AMZN", "metrics": {"pe_ratio": 30.1, "free_cash_flow": 3_219_124_992}, "history": []}
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/yahoo/fundamentals": body}, [])):
        out = await build_toolkit(None).get_fundamentals.ainvoke({"ticker": "AMZN", "curr_date": "2026-10-31"})
    assert '"free_cash_flow"' not in out
    assert '"yahoo_levered_fcf": 3219124992' in out
    assert "not OCF − capex" in out
    assert "get_cashflow" in out
