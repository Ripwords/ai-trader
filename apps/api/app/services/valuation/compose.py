from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.services.valuation.assumptions import (
    EXPLICIT_YEARS, build_default_assumptions, derive_growth,
)
from app.services.valuation.engine import (
    current_multiples, dcf, historical_self_multiples, margin_of_safety, reverse_dcf,
)
from app.services.valuation.models import (
    Assumptions, Scenario, ValuationInput, ValuationResult, Veto,
)
from app.services.valuation.verify import verify_market_cap

RATING_SEVERITY = {
    "sell": 0, "reduce": 1, "hold": 2, "buy": 3, "strong-buy": 4,
}

_SCENARIO_GROWTH_DELTA = Decimal("0.03")   # +/- on the base growth
# A DCF is only meaningful inside a regime: base FCF that is a real share of
# revenue, agreeing in sign with trailing OCF − capex, and a fair value
# within a plausible band around the price. Outside it the output is noise
# (AMZN Q3 2026: a $3.6 fair value against a $254.60 price, from a +$3.2B
# levered-FCF base while trailing OCF − capex was −$46.9B).
_NEAR_ZERO_FCF_MARGIN = Decimal("0.01")    # base FCF / latest revenue
_REGIME_MIN_FV_TO_PRICE = Decimal("0.20")
_REGIME_MAX_FV_TO_PRICE = Decimal("5")

_SCENARIO_PROBS = {
    "optimistic": Decimal("0.25"),
    "neutral": Decimal("0.50"),
    "pessimistic": Decimal("0.25"),
}


def _safe_dcf(vi, growth_rates, a) -> Decimal | None:
    try:
        return dcf(vi.fcf_base, growth_rates, a.discount_rate,
                   a.terminal_growth, vi.net_debt, vi.shares_outstanding)
    except (ValueError, InvalidOperation, ZeroDivisionError):
        return None


def _money(v: Decimal) -> str:
    sign = "-" if v < 0 else ""
    a = abs(v)
    for div, suffix in ((Decimal("1e12"), "T"), (Decimal("1e9"), "B"), (Decimal("1e6"), "M")):
        if a >= div:
            return f"{sign}{a / div:.2f}{suffix}"
    return f"{sign}{a:.2f}"


def _base_fcf_out_of_regime(vi: ValuationInput) -> str | None:
    """Why the positive base FCF can't anchor a DCF, or None when it can."""
    assert vi.fcf_base is not None
    if vi.fcf_ttm is not None and vi.fcf_ttm <= 0:
        period = vi.fcf_ttm_period or "trailing twelve months"
        return (
            f"the base FCF ({_money(vi.fcf_base)}) conflicts with operating cash "
            f"flow minus capex of {_money(vi.fcf_ttm)} ({period}); the base is "
            f"stale or differently defined, and a DCF on negative FCF is undefined"
        )
    revenue = next((p.revenue for p in vi.history if p.revenue), None)
    if revenue and revenue > 0 and vi.fcf_base / revenue < _NEAR_ZERO_FCF_MARGIN:
        return (
            f"the base FCF ({_money(vi.fcf_base)}) is near zero, "
            f"{vi.fcf_base / revenue:.2%} of {_money(revenue)} revenue, so the DCF "
            f"just capitalises a rounding error (typical when heavy growth capex "
            f"temporarily absorbs operating cash flow)"
        )
    return None


def _fair_value_out_of_regime(fair_value: Decimal, price: Decimal) -> str | None:
    ratio = fair_value / price
    if _REGIME_MIN_FV_TO_PRICE <= ratio <= _REGIME_MAX_FV_TO_PRICE:
        return None
    return (
        f"the DCF fair value ({fair_value:.2f}/share) is {ratio:.1%} of the price "
        f"({price:.2f}), outside the {_REGIME_MIN_FV_TO_PRICE:.0%}–"
        f"{_REGIME_MAX_FV_TO_PRICE:.0%} band a DCF can resolve; the FCF base does "
        f"not represent the business's earning power or the inputs are anomalous"
    )


def _invalid_dcf(vi, cur_mult, hist_mult, a, reason: str) -> ValuationResult:
    return ValuationResult(
        symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
        margin_of_safety_pct=None, scenarios=[], assumptions_used=a,
        multiples=cur_mult, historical_multiples=hist_mult,
        reverse_dcf_implied_growth=None, data_quality="multiples_only",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=[f"DCF out of regime and discarded: {reason}; it does not cap the rating"],
        dcf_invalid_reason=reason,
    )


def value(
    vi: ValuationInput,
    overrides: Assumptions | None = None,
    avg_price_by_period: dict[str, Decimal] | None = None,
) -> ValuationResult:
    result = _value(vi, overrides, avg_price_by_period)
    result.currency = vi.currency
    if vi.price_note:
        result.warnings.append(vi.price_note)
    return result


def _value(
    vi: ValuationInput,
    overrides: Assumptions | None,
    avg_price_by_period: dict[str, Decimal] | None,
) -> ValuationResult:
    warnings: list[str] = []
    if vi.current_price <= 0:
        # No price feed means no margin of safety, no multiples and no
        # screener rank; a zero price would otherwise produce MoS +100% and
        # sort to the top as the cheapest stock on the list.
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=None,
            multiples=None, historical_multiples=None,
            reverse_dcf_implied_growth=None, data_quality="unavailable",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=["no current price available; valuation not computed"],
        )
    cur_mult = current_multiples(vi.metrics, vi.current_price)
    hist_mult = None
    eff_avg = avg_price_by_period or vi.avg_price_by_period
    if eff_avg and vi.shares_outstanding:
        hist_mult = historical_self_multiples(
            vi.history, vi.shares_outstanding, eff_avg)

    dcf_invalid = (
        vi.fcf_base is None or vi.fcf_base <= 0
        or vi.shares_outstanding is None or vi.shares_outstanding <= 0
    )
    if dcf_invalid:
        warnings.append("DCF skipped: non-positive FCF or missing shares; "
                        "multiples-only (no fabricated fair value)")
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=None,
            multiples=cur_mult, historical_multiples=hist_mult,
            reverse_dcf_implied_growth=None, data_quality="multiples_only",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=warnings,
        )

    a = overrides or build_default_assumptions(vi.history, vi.beta)
    base_reason = _base_fcf_out_of_regime(vi)
    if base_reason:
        return _invalid_dcf(vi, cur_mult, hist_mult, a, base_reason)
    fair_value = _safe_dcf(vi, a.growth_rates, a)
    if fair_value is not None and fair_value <= 0:
        warnings.append(
            f"DCF equity value is non-positive ({fair_value:.2f}/share: net debt "
            "exceeds the discounted cash flows); no fair value or margin of "
            "safety can be stated, multiples-only"
        )
        fair_value = None
    if fair_value is None:
        if not warnings:
            warnings.append("DCF computation failed; multiples-only")
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=a,
            multiples=cur_mult, historical_multiples=hist_mult,
            reverse_dcf_implied_growth=None, data_quality="multiples_only",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=warnings,
        )

    fv_reason = _fair_value_out_of_regime(fair_value, vi.current_price)
    if fv_reason:
        return _invalid_dcf(vi, cur_mult, hist_mult, a, fv_reason)

    base_g = a.growth_rates[0]
    scenarios: list[Scenario] = []
    for name, gdelta in (("optimistic", _SCENARIO_GROWTH_DELTA),
                         ("neutral", Decimal("0")),
                         ("pessimistic", -_SCENARIO_GROWTH_DELTA)):
        g = base_g + gdelta
        fv = _safe_dcf(vi, [g] * len(a.growth_rates), a)
        if fv is None:
            continue
        scenarios.append(Scenario(name=name, growth=g, discount=a.discount_rate,
                                  fair_value=fv, probability=_SCENARIO_PROBS[name]))

    mos = margin_of_safety(fair_value, vi.current_price)
    try:
        implied = reverse_dcf(vi.current_price, vi.fcf_base, a.discount_rate,
                              a.terminal_growth, vi.net_debt, vi.shares_outstanding,
                              explicit_years=EXPLICIT_YEARS)
    except (ValueError, InvalidOperation):
        implied = None

    result = ValuationResult(
        symbol=vi.symbol, current_price=vi.current_price, fair_value=fair_value,
        margin_of_safety_pct=mos, scenarios=scenarios, assumptions_used=a,
        multiples=cur_mult, historical_multiples=hist_mult,
        reverse_dcf_implied_growth=implied, data_quality="full",
        veto=Veto(triggered=False, reason=None, rating_cap=None), warnings=warnings,
    )
    result.veto = _compute_veto(vi, result)
    # Guardrail: when the market price diverges wildly from the DCF fair value
    # (>= ~3x, i.e. MoS <= -200%), the output is out-of-regime. This is usually
    # deeply cyclical/normalized FCF or an upstream data anomaly (e.g. an
    # unadjusted split inflating the price feed ~10x vs the fundamentals feed,
    # as seen for US.MU). Surface it instead of printing a confident -1880%.
    if fair_value > 0 and mos <= Decimal("-2.0"):
        ratio = vi.current_price / fair_value
        result.warnings.append(
            f"market price is {ratio:.1f}x the DCF fair value (margin of safety "
            f"{mos:.0%}); the price implies FCF growth beyond the model's range — "
            f"likely deeply cyclical/normalized FCF or a data anomaly (e.g. an "
            f"unadjusted split in the price feed). Treat the fair value as "
            f"out-of-regime, not a precise target."
        )
    # v1 single-source market-cap sanity check; full two-source cross_source_check deferred to v2
    if vi.shares_outstanding is not None and vi.metrics.market_cap is not None:
        ok, msg = verify_market_cap(vi.current_price, vi.shares_outstanding, vi.metrics.market_cap)
        if not ok and msg:
            result.warnings.append(msg)
    return result


def _compute_veto(vi: ValuationInput, result: ValuationResult) -> Veto:
    # (a) grossly overvalued by DCF
    if result.margin_of_safety_pct is not None and result.margin_of_safety_pct <= Decimal("-0.50"):
        return Veto(triggered=True, rating_cap="hold",
                    reason=f"price >= 1.5x DCF fair value "
                           f"(margin of safety {result.margin_of_safety_pct:.1%})")
    # (b) reverse-DCF implies implausible growth
    base_g = derive_growth(vi.history)
    if (result.reverse_dcf_implied_growth is not None and base_g > 0
            and result.reverse_dcf_implied_growth > Decimal("2.5") * base_g):
        return Veto(triggered=True, rating_cap="hold",
                    reason=f"price implies {result.reverse_dcf_implied_growth:.1%} growth, "
                           f">2.5x historical {base_g:.1%}")
    return Veto(triggered=False, reason=None, rating_cap=None)


def _cap_rating(rating: str, cap: str) -> str:
    if rating not in RATING_SEVERITY or cap not in RATING_SEVERITY:
        return rating
    return cap if RATING_SEVERITY[rating] > RATING_SEVERITY[cap] else rating


def apply_veto(rating: str, result: ValuationResult) -> tuple[str, Veto]:
    # multiples-only PS>30 veto (computed here since it needs no DCF)
    veto = result.veto
    if (not veto.triggered and result.data_quality == "multiples_only"
            and result.multiples and result.multiples.ps is not None
            and result.multiples.ps > Decimal("30")):
        veto = Veto(triggered=True, rating_cap="hold",
                    reason=f"no positive FCF and P/S {result.multiples.ps:.1f} > 30x")
    if not veto.triggered or veto.rating_cap is None:
        return rating, veto
    return _cap_rating(rating, veto.rating_cap), veto
