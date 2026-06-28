from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, getcontext

getcontext().prec = 28

_TWO = Decimal("2")


def dcf(
    fcf_base: Decimal,
    growth_rates: list[Decimal],
    discount_rate: Decimal,
    terminal_growth: Decimal,
    net_debt: Decimal,
    shares: Decimal,
) -> Decimal:
    """Multi-stage FCF DCF -> fair value per share.

    Projects FCF over the explicit window (one rate per year in
    ``growth_rates``), adds a Gordon terminal value off the final projected
    FCF, discounts everything to PV, subtracts net debt, divides by shares.
    """
    if shares <= 0:
        raise ValueError("shares must be positive")
    if discount_rate <= terminal_growth:
        raise ValueError("discount_rate must exceed terminal_growth")

    fcf = fcf_base
    pv_sum = Decimal("0")
    for i, g in enumerate(growth_rates, start=1):
        fcf = fcf * (Decimal("1") + g)
        pv_sum += fcf / (Decimal("1") + discount_rate) ** i

    terminal_fcf = fcf * (Decimal("1") + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    n = len(growth_rates)
    pv_terminal = terminal_value / (Decimal("1") + discount_rate) ** n

    enterprise_value = pv_sum + pv_terminal
    equity_value = enterprise_value - net_debt
    return equity_value / shares


def margin_of_safety(fair_value: Decimal, price: Decimal) -> Decimal:
    """(fair - price) / fair. Positive = undervalued, negative = overvalued."""
    if fair_value == 0:
        raise ValueError("fair_value must be non-zero")
    return (fair_value - price) / fair_value


def reverse_dcf(
    price: Decimal,
    fcf_base: Decimal,
    discount_rate: Decimal,
    terminal_growth: Decimal,
    net_debt: Decimal,
    shares: Decimal,
    explicit_years: int = 5,
) -> Decimal:
    """Bisection-solve the flat annual growth that makes ``dcf`` == ``price``.

    ai-berkshire's reality check: what growth does the current price imply?
    Searches g in [-0.50, 1.00]; returns the midpoint at convergence.
    """
    lo, hi = Decimal("-0.50"), Decimal("1.00")
    target = price
    for _ in range(200):
        mid = (lo + hi) / _TWO
        fv = dcf(fcf_base, [mid] * explicit_years, discount_rate,
                 terminal_growth, net_debt, shares)
        if abs(fv - target) < Decimal("0.0000001"):
            return mid
        if fv < target:
            lo = mid
        else:
            hi = mid
    return ((lo + hi) / _TWO).quantize(Decimal("0.000001"), ROUND_HALF_EVEN)
