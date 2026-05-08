"""Unit tests for the deterministic research analysts.

Each analyst is a pure function — we feed it a duck-typed metrics/bars/news
fixture and assert the resulting signal direction. No HTTP, no fundamentals
service dependency.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.schemas.quote import Bar
from app.services.research.fundamentals_analyst import score_fundamentals
from app.services.research.sentiment_analyst import score_sentiment
from app.services.research.technicals_analyst import score_technicals
from app.services.research.valuation_analyst import score_valuation


@dataclass
class FakeMetrics:
    return_on_equity: float | None = None
    profit_margin: float | None = None
    revenue_growth: float | None = None
    debt_to_equity: float | None = None
    current_ratio: float | None = None
    market_cap: float | None = None
    free_cash_flow: float | None = None
    net_income: float | None = None
    capex: float | None = None
    depreciation_amortization: float | None = None
    ebitda: float | None = None
    operating_income: float | None = None
    operating_margin: float | None = None
    revenue: float | None = None
    total_debt: float | None = None
    cash: float | None = None
    book_value: float | None = None


@dataclass
class FakeInsiderTrade:
    transaction_shares: float
    filing_date: datetime | None = None


@dataclass
class FakeNewsItem:
    sentiment: str


def _bars_from_closes(closes: list[float]) -> list[Bar]:
    base = datetime(2025, 1, 1)
    return [
        Bar(
            time=base + timedelta(days=i),
            open=c,
            high=c * 1.01,
            low=c * 0.99,
            close=c,
            volume=1_000_000,
            turnover=c * 1_000_000,
        )
        for i, c in enumerate(closes)
    ]


# --- fundamentals --------------------------------------------------------


def test_fundamentals_strong_company_is_bullish():
    m = FakeMetrics(
        return_on_equity=0.25,
        profit_margin=0.30,
        revenue_growth=0.20,
        debt_to_equity=0.3,
        current_ratio=2.5,
    )
    sig = score_fundamentals("US.NVDA", m)
    assert sig.signal == "bullish"
    assert sig.confidence > 50
    assert sig.source == "fundamentals"


def test_fundamentals_weak_company_is_bearish():
    m = FakeMetrics(
        return_on_equity=0.02,
        profit_margin=0.01,
        revenue_growth=-0.05,
        debt_to_equity=3.5,  # > 2 => bearish
        current_ratio=0.8,
    )
    sig = score_fundamentals("US.WEAK", m)
    assert sig.signal == "bearish"


# --- valuation -----------------------------------------------------------


def test_valuation_undervalued_company_is_bullish():
    # FCF 1B, mcap 5B -> DCF alone yields ~28B (5y growth + 15x terminal),
    # so the weighted gap is firmly positive.
    m = FakeMetrics(
        market_cap=5_000_000_000,
        free_cash_flow=1_000_000_000,
        net_income=900_000_000,
        capex=200_000_000,
        depreciation_amortization=300_000_000,
        ebitda=1_200_000_000,
        operating_income=1_100_000_000,
        revenue=8_000_000_000,
        operating_margin=0.14,
        total_debt=500_000_000,
        cash=300_000_000,
        book_value=4_000_000_000,
        return_on_equity=0.22,
    )
    sig = score_valuation("US.UND", m)
    assert sig.signal == "bullish"
    assert sig.confidence > 0


def test_valuation_overvalued_company_is_bearish():
    # Tiny FCF / earnings vs huge market cap -> deeply negative gap.
    m = FakeMetrics(
        market_cap=500_000_000_000,
        free_cash_flow=1_000_000_000,
        net_income=800_000_000,
        capex=300_000_000,
        depreciation_amortization=200_000_000,
        ebitda=1_500_000_000,
        operating_income=1_200_000_000,
        revenue=10_000_000_000,
        operating_margin=0.12,
        total_debt=2_000_000_000,
        cash=500_000_000,
        book_value=5_000_000_000,
        return_on_equity=0.16,
    )
    sig = score_valuation("US.OVR", m)
    assert sig.signal == "bearish"


# --- technicals ----------------------------------------------------------


def test_technicals_uptrend_is_bullish():
    # Steady uptrend: EMAs stack 8>21>55, momentum >+10%.
    closes = [100 + i * 0.5 for i in range(200)]
    sig = score_technicals("US.UP", _bars_from_closes(closes))
    assert sig.signal == "bullish"
    assert (sig.metadata or {})["trend"] == 1
    assert (sig.metadata or {})["momentum"] == 1


def test_technicals_downtrend_is_bearish():
    closes = [200 - i * 0.5 for i in range(200)]
    sig = score_technicals("US.DN", _bars_from_closes(closes))
    assert sig.signal == "bearish"
    assert (sig.metadata or {})["trend"] == -1
    assert (sig.metadata or {})["momentum"] == -1


# --- sentiment -----------------------------------------------------------


def _recent(days: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days)


def test_sentiment_buys_and_positive_news_is_bullish():
    insider = [
        FakeInsiderTrade(transaction_shares=1000, filing_date=_recent(10)),
        FakeInsiderTrade(transaction_shares=500, filing_date=_recent(40)),
    ]
    news = [FakeNewsItem(sentiment="positive") for _ in range(8)] + [
        FakeNewsItem(sentiment="negative")
    ]
    sig = score_sentiment("US.GOOD", insider, news)
    assert sig.signal == "bullish"
    assert sig.confidence > 50


def test_sentiment_sells_and_negative_news_is_bearish():
    insider = [
        FakeInsiderTrade(transaction_shares=-2000, filing_date=_recent(15)),
        FakeInsiderTrade(transaction_shares=-1000, filing_date=_recent(30)),
        FakeInsiderTrade(transaction_shares=-500, filing_date=_recent(60)),
    ]
    news = [FakeNewsItem(sentiment="negative") for _ in range(6)] + [
        FakeNewsItem(sentiment="positive")
    ]
    sig = score_sentiment("US.BAD", insider, news)
    assert sig.signal == "bearish"


def test_sentiment_no_data_is_neutral():
    sig = score_sentiment("US.QUIET", [], [])
    assert sig.signal == "neutral"
    assert sig.confidence == 0
