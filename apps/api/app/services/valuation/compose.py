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


def value(
    vi: ValuationInput,
    overrides: Assumptions | None = None,
    avg_price_by_period: dict[str, Decimal] | None = None,
) -> ValuationResult:
    warnings: list[str] = []
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
    fair_value = _safe_dcf(vi, a.growth_rates, a)
    if fair_value is None:
        warnings.append("DCF computation failed; multiples-only")
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=a,
            multiples=cur_mult, historical_multiples=hist_mult,
            reverse_dcf_implied_growth=None, data_quality="multiples_only",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=warnings,
        )

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
                           f"(margin of safety {result.margin_of_safety_pct:.2f})")
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
