"""Pydantic schemas for the deterministic research analyst surface."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.fundamentals import FinancialMetrics, InsiderTrade, NewsItem

SignalType = Literal["bullish", "bearish", "neutral"]


class Signal(BaseModel):
    source: str
    symbol: str
    signal: SignalType
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    metadata: dict[str, Any] | None = None


class AnalystRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)


class FundamentalsRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    metrics: FinancialMetrics


class ValuationRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    metrics: FinancialMetrics


class SentimentRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    insider: list[InsiderTrade] = Field(default_factory=list)
    news: list[NewsItem] = Field(default_factory=list)
