"""Alpha Vantage tools: the earnings-call transcript and estimate revisions.

The web side owns the 25-requests-a-day budget; these tools only render what
it returns, including the quota left and the reason when it says no.
"""

from unittest.mock import patch

import pytest

from app.services.agents.toolkit import build_toolkit
from tests.agents.test_toolkit_earnings import _fake_http, _internal_env  # noqa: F401 - autouse fixture

QUOTA = {"date": "2026-10-31", "used": 5, "limit": 25, "remaining": 20, "exhausted": False, "configured": True}

TRANSCRIPT = {
    "status": "ok",
    "cached": False,
    "source": "Alpha Vantage (alphavantage.co) EARNINGS_CALL_TRANSCRIPT",
    "quota": QUOTA,
    "data": {
        "symbol": "AMZN",
        "quarter": "2026Q2",
        "prepared": [
            {"speaker": "Andy Jassy", "title": "Chief Executive Officer", "sentiment": 0.9,
             "content": "AWS grew 39%, the fastest in years; we are capacity constrained.", "truncated": False},
        ],
        "qa": [
            {"speaker": "Doug Anmuth", "title": "Analyst, J.P. Morgan", "sentiment": 0.0,
             "content": "How durable is the acceleration?", "truncated": False},
            {"speaker": "Brian Olsavsky", "title": "Chief Financial Officer", "sentiment": 0.5,
             "content": "x" * 5000, "truncated": True},
        ],
        "total_chars": 47_800,
        "notes": ["No 2026Q3 transcript published yet."],
    },
}

ESTIMATES = {
    "status": "ok",
    "cached": True,
    "source": "Alpha Vantage (alphavantage.co) EARNINGS_ESTIMATES",
    "quota": QUOTA,
    "data": {
        "symbol": "AMZN",
        "forward": [
            {"date": "2026-12-31", "horizon": "quarter", "eps_avg": 2.4559, "eps_low": 2.0, "eps_high": 2.75,
             "eps_analysts": 43, "eps_7d_ago": 2.4478, "eps_30d_ago": 2.4326, "eps_90d_ago": 2.3989,
             "eps_change_90d_pct": 2.376, "revisions_7d": {"up": 1, "down": None},
             "revisions_30d": {"up": 2, "down": 1}, "revenue_avg": 244_309_143_060,
             "revenue_low": 234e9, "revenue_high": 255.9e9, "revenue_analysts": 47},
        ],
        "reported": [
            {"date": "2026-09-30", "horizon": "quarter", "eps_avg": 1.9594, "eps_low": None, "eps_high": None,
             "eps_analysts": 46, "eps_7d_ago": None, "eps_30d_ago": None, "eps_90d_ago": 1.918,
             "eps_change_90d_pct": 2.16, "revisions_7d": {"up": None, "down": None},
             "revisions_30d": {"up": 2, "down": None}, "revenue_avg": 202_264_872_830,
             "revenue_low": None, "revenue_high": None, "revenue_analysts": 47},
        ],
    },
}


@pytest.mark.asyncio
async def test_transcript_renders_remarks_qa_sentiment_and_quota():
    calls: list[dict] = []
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/alpha-vantage/transcript": TRANSCRIPT}, calls)):
        out = await build_toolkit(None).get_earnings_call_transcript.ainvoke({"ticker": "US.AMZN"})
    assert calls[0]["params"] == {"symbol": "US.AMZN"}
    assert "2026Q2" in out
    assert "Prepared remarks" in out and "Q&A" in out
    assert "Andy Jassy (Chief Executive Officer, sentiment +0.90)" in out
    assert "capacity constrained" in out
    assert "No 2026Q3 transcript published yet." in out
    assert "20 of 25" in out
    assert "[turn truncated]" in out


@pytest.mark.asyncio
async def test_transcript_passes_a_quarter():
    calls: list[dict] = []
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/alpha-vantage/transcript": TRANSCRIPT}, calls)):
        await build_toolkit(None).get_earnings_call_transcript.ainvoke({"ticker": "AMZN", "quarter": "2026Q2"})
    assert calls[0]["params"] == {"symbol": "AMZN", "quarter": "2026Q2"}


@pytest.mark.asyncio
async def test_transcript_quota_exhausted_tells_the_analyst_to_move_on():
    body = {"status": "unavailable", "reason": "quota_exhausted", "message": "daily limit (25) reached",
            "source": "Alpha Vantage", "quota": {**QUOTA, "used": 25, "remaining": 0, "exhausted": True}}
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/alpha-vantage/transcript": body}, [])):
        out = await build_toolkit(None).get_earnings_call_transcript.ainvoke({"ticker": "AMZN"})
    assert "quota" in out.lower()
    assert "get_earnings_release" in out  # points at the fallback
    assert "do not call" in out.lower()


@pytest.mark.asyncio
async def test_transcript_upstream_error_fails_soft():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/alpha-vantage/transcript": 502}, [])):
        out = await build_toolkit(None).get_earnings_call_transcript.ainvoke({"ticker": "AMZN"})
    assert "unavailable" in out.lower()


@pytest.mark.asyncio
async def test_estimate_revisions_table():
    with patch("httpx.AsyncClient.get", new=_fake_http({"/api/internal/alpha-vantage/estimates": ESTIMATES}, [])):
        out = await build_toolkit(None).get_estimate_revisions.ainvoke({"ticker": "AMZN"})
    assert "| quarter 2026-12-31 | 2.46 | 2.40 | +2.38% | 2 / 1 | 244.31B | 43 |" in out
    assert "| 2026-09-30 | 1.96 | 202.26B |" in out
    assert "Alpha Vantage" in out
    assert "20 of 25" in out
