from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Model(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=False)


class HistoryPeriod(_Model):
    period: str
    revenue: Decimal | None = None
    net_income: Decimal | None = None
    fcf: Decimal | None = None
    total_debt: Decimal | None = None
    shareholders_equity: Decimal | None = None


class Metrics(_Model):
    market_cap: Decimal | None = None
    pe_ratio: Decimal | None = None
    pb_ratio: Decimal | None = None
    ps_ratio: Decimal | None = None
    eps: Decimal | None = None
    free_cash_flow: Decimal | None = None
    shares_outstanding: Decimal | None = None
    beta: Decimal | None = None


class Assumptions(_Model):
    growth_rates: list[Decimal]
    discount_rate: Decimal
    terminal_growth: Decimal


class ValuationInput(_Model):
    symbol: str
    current_price: Decimal
    fcf_base: Decimal | None
    net_debt: Decimal
    shares_outstanding: Decimal | None
    beta: Decimal | None
    history: list[HistoryPeriod]
    metrics: Metrics
    avg_price_by_period: dict[str, Decimal] | None = None


class Scenario(_Model):
    name: Literal["optimistic", "neutral", "pessimistic"]
    growth: Decimal
    discount: Decimal
    fair_value: Decimal
    probability: Decimal


class Multiples(_Model):
    pe: Decimal | None = None
    pb: Decimal | None = None
    ps: Decimal | None = None
    p_fcf: Decimal | None = None


class Veto(_Model):
    triggered: bool
    reason: str | None
    rating_cap: str | None


class ValuationResult(_Model):
    symbol: str
    current_price: Decimal
    fair_value: Decimal | None
    margin_of_safety_pct: Decimal | None
    scenarios: list[Scenario]
    assumptions_used: Assumptions | None
    multiples: Multiples | None
    historical_multiples: Multiples | None
    reverse_dcf_implied_growth: Decimal | None
    data_quality: Literal["full", "multiples_only", "unavailable"]
    veto: Veto
    warnings: list[str] = []
