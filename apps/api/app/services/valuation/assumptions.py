from __future__ import annotations

from decimal import Decimal

from app.services.valuation.models import Assumptions, HistoryPeriod

EXPLICIT_YEARS = 5
TERMINAL_GROWTH = Decimal("0.025")
_GROWTH_FLOOR = Decimal("-0.05")
_GROWTH_CAP = Decimal("0.20")
_GROWTH_HAIRCUT = Decimal("0.75")
_GROWTH_FALLBACK = Decimal("0.03")
_DISCOUNT_FLOOR = Decimal("0.07")
_DISCOUNT_CEIL = Decimal("0.15")


def derive_growth(history: list[HistoryPeriod]) -> Decimal:
    """Dampened FCF CAGR from the historical series (Yahoo order: newest-first).

    Falls back to 3% when fewer than two positive FCF points exist
    (ai-berkshire: don't fabricate a trend from no data)."""
    fcfs = [h.fcf for h in history if h.fcf is not None and h.fcf > 0]
    if len(fcfs) < 2:
        return _GROWTH_FALLBACK
    newest, oldest = fcfs[0], fcfs[-1]   # history is newest-first
    intervals = len(fcfs) - 1
    cagr = (newest / oldest) ** (Decimal("1") / Decimal(intervals)) - Decimal("1")
    cagr = max(_GROWTH_FLOOR, min(_GROWTH_CAP, cagr))
    return cagr * _GROWTH_HAIRCUT


def derive_discount_rate(
    beta: Decimal | None,
    rf: Decimal = Decimal("0.04"),
    erp: Decimal = Decimal("0.05"),
) -> Decimal:
    b = beta if beta is not None else Decimal("1")
    capm = rf + b * erp
    return max(_DISCOUNT_FLOOR, min(_DISCOUNT_CEIL, capm))


def build_default_assumptions(
    history: list[HistoryPeriod],
    beta: Decimal | None,
    explicit_years: int = EXPLICIT_YEARS,
) -> Assumptions:
    g = derive_growth(history)
    return Assumptions(
        growth_rates=[g] * explicit_years,
        discount_rate=derive_discount_rate(beta),
        terminal_growth=TERMINAL_GROWTH,
    )
