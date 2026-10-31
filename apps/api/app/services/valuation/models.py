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
    cash: Decimal | None = None
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
    # Currency every price and per-share figure is expressed in (the
    # statements' currency once the web side has converted the quote).
    currency: str | None = None
    # Something the web side did or could not do to the price series that
    # the result must disclose.
    price_note: str | None = None
    # Trailing-twelve-month operating cash flow minus capex, as a cross-check
    # on ``fcf_base`` (which may be a differently defined or stale figure),
    # and the period it covers ("TTM to 2026-09-30").
    fcf_ttm: Decimal | None = None
    fcf_ttm_period: str | None = None
    # Yahoo assetProfile.industry ("Banks - Diversified"); decides whether an
    # FCF DCF means anything for this business.
    industry: str | None = None


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
    # Currency of current_price, fair_value and the scenario fair values.
    currency: str | None = None
    # Why the DCF was judged out of regime and discarded. When set, no fair
    # value is stated and the DCF never caps the rating.
    dcf_invalid_reason: str | None = None
