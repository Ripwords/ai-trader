from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class FinancialMetrics(BaseModel):
    symbol: str
    market_cap: float | None = None
    pe_ratio: float | None = None
    pb_ratio: float | None = None
    ps_ratio: float | None = None
    eps: float | None = None
    dividend_yield: float | None = None
    return_on_equity: float | None = None
    return_on_assets: float | None = None
    profit_margin: float | None = None
    operating_margin: float | None = None
    revenue_growth: float | None = None
    earnings_growth: float | None = None
    debt_to_equity: float | None = None
    current_ratio: float | None = None
    free_cash_flow: float | None = None
    beta: float | None = None
    shares_outstanding: float | None = None


class HistoricalPeriod(BaseModel):
    period: str
    revenue: float | None = None
    net_income: float | None = None
    eps: float | None = None
    fcf: float | None = None
    total_debt: float | None = None
    total_assets: float | None = None
    shareholders_equity: float | None = None


class FundamentalsBundle(BaseModel):
    metrics: FinancialMetrics
    history: list[HistoricalPeriod]


class InsiderTrade(BaseModel):
    date: str
    insider_name: str
    transaction_type: Literal["buy", "sell"]
    shares: int
    value: float | None = None


class NewsItem(BaseModel):
    title: str
    url: str
    published_at: str
    sentiment: Literal["positive", "negative", "neutral"] | None = None
