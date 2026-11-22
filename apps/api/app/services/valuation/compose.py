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
_REGIME_MAX_PRICE_TO_FV = Decimal("3")     # margin of safety of -200%
_REGIME_MAX_FV_TO_PRICE = Decimal("5")

# Inside the regime the DCF caps the rating only when both hold: it signals
# overvaluation, and the stock trades well above its own historical multiple.
# Growth is a dampened backward FCF CAGR capped at 15%, so the DCF signal
# alone fires on most durable growers (AAPL, MSFT, NVDA and V at once).
_VETO_MAX_MARGIN_OF_SAFETY = Decimal("-0.50")      # price >= 1.5x fair value
_VETO_IMPLIED_GROWTH_MULTIPLE = Decimal("2.5")     # reverse-DCF growth / base growth
_VETO_OWN_MULTIPLE_STRETCH = Decimal("1.5")        # current P/E or P/S / own history
_MULTIPLES_ONLY_MAX_PS = Decimal("30")

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


# Yahoo industries whose operating cash flow carries deposits, loans, float or
# client balances, so OCF − capex is not cash the owners can take out.
# Card networks ("Credit Services") and asset managers keep their DCF.
_BALANCE_SHEET_INDUSTRIES = ("Banks", "Insurance", "Capital Markets", "Mortgage Finance")


def _industry_out_of_regime(vi: ValuationInput) -> str | None:
    """Why no FCF DCF applies to this kind of business, or None when one does."""
    if vi.industry and vi.industry.startswith(_BALANCE_SHEET_INDUSTRIES):
        return (
            f"the company is in {vi.industry}, where operating cash flow moves with "
            f"deposits, loans or policy float, so OCF − capex is not free cash flow; "
            f"judge it on P/B against return on equity, and P/E"
        )
    return None


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
    if price >= _REGIME_MAX_PRICE_TO_FV * fair_value:
        bound = (
            f"the price is {price / fair_value:.1f}x fair value, at or beyond the "
            f"{_REGIME_MAX_PRICE_TO_FV}x (margin of safety "
            f"{1 - _REGIME_MAX_PRICE_TO_FV:.0%}) a DCF can resolve"
        )
    elif fair_value > _REGIME_MAX_FV_TO_PRICE * price:
        bound = (
            f"fair value is {fair_value / price:.1f}x the price, beyond the "
            f"{_REGIME_MAX_FV_TO_PRICE}x a DCF can resolve"
        )
    else:
        return None
    return (
        f"the DCF fair value ({fair_value:.2f}/share) is {fair_value / price:.1%} of the "
        f"price ({price:.2f}): {bound}; the FCF base or the growth extrapolated from "
        f"its history does not represent the business's earning power, or the inputs "
        f"are anomalous (e.g. an unadjusted split in the price feed)"
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
    cur_mult = current_multiples(vi.metrics, vi.current_price, vi.fcf_base)
    hist_mult = None
    eff_avg = avg_price_by_period or vi.avg_price_by_period
    if eff_avg and vi.shares_outstanding:
        hist_mult = historical_self_multiples(
            vi.history, vi.shares_outstanding, eff_avg)

    industry_reason = _industry_out_of_regime(vi)
    if industry_reason:
        return _invalid_dcf(vi, cur_mult, hist_mult, None, industry_reason)

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
    result.veto, uncapped_note = _compute_veto(vi, result)
    if uncapped_note:
        result.warnings.append(uncapped_note)
    # v1 single-source market-cap sanity check; full two-source cross_source_check deferred to v2
    if vi.shares_outstanding is not None and vi.metrics.market_cap is not None:
        ok, msg = verify_market_cap(vi.current_price, vi.shares_outstanding, vi.metrics.market_cap)
        if not ok and msg:
            result.warnings.append(msg)
    return result


def _dcf_overvaluation_signal(vi: ValuationInput, result: ValuationResult) -> str | None:
    mos = result.margin_of_safety_pct
    if mos is not None and mos <= _VETO_MAX_MARGIN_OF_SAFETY:
        return (f"price >= {1 - _VETO_MAX_MARGIN_OF_SAFETY:.1f}x DCF fair value "
                f"(margin of safety {mos:.1%})")
    base_g = derive_growth(vi.history)
    implied = result.reverse_dcf_implied_growth
    if implied is not None and base_g > 0 and implied > _VETO_IMPLIED_GROWTH_MULTIPLE * base_g:
        return (f"price implies {implied:.1%} growth, "
                f">{_VETO_IMPLIED_GROWTH_MULTIPLE}x historical {base_g:.1%}")
    return None


def _own_multiple_stretches(result: ValuationResult) -> list[tuple[str, Decimal, Decimal]]:
    """(label, current, own history) for each multiple both sides can state."""
    now, past = result.multiples, result.historical_multiples
    if now is None or past is None:
        return []
    pairs = (("P/E", now.pe, past.pe), ("P/S", now.ps, past.ps))
    return [(label, n, p) for label, n, p in pairs
            if n is not None and p is not None and n > 0 and p > 0]


def _compute_veto(vi: ValuationInput, result: ValuationResult) -> tuple[Veto, str | None]:
    """The veto, and when a DCF signal did not become a cap, the note saying why."""
    signal = _dcf_overvaluation_signal(vi, result)
    if signal is None:
        return Veto(triggered=False, reason=None, rating_cap=None), None
    pairs = _own_multiple_stretches(result)
    if not pairs:
        return (
            Veto(triggered=False, reason=None, rating_cap=None, corroboration="unavailable"),
            f"DCF overvaluation signal not applied as a rating cap: {signal}, but no "
            f"historical P/E or P/S of the stock's own was available to corroborate "
            f"it; the valuation check is unverified, not passed",
        )
    stretched = [pair for pair in pairs if pair[1] / pair[2] >= _VETO_OWN_MULTIPLE_STRETCH]
    described = ", ".join(
        f"{label} {n:.1f} is {n / p:.1f}x its own history ({p:.1f})"
        for label, n, p in (stretched or pairs))
    if stretched:
        return Veto(triggered=True, rating_cap="hold", corroboration="corroborated",
                    reason=f"{signal}, and {described}"), None
    return (
        Veto(triggered=False, reason=None, rating_cap=None, corroboration="not_corroborated"),
        f"DCF overvaluation signal not applied as a rating cap: {signal}, but "
        f"{described}, under the {_VETO_OWN_MULTIPLE_STRETCH}x that would corroborate "
        f"it; a DCF on a dampened, capped FCF trend does not cap the rating alone",
    )


def _cap_rating(rating: str, cap: str) -> str:
    if rating not in RATING_SEVERITY or cap not in RATING_SEVERITY:
        return rating
    return cap if RATING_SEVERITY[rating] > RATING_SEVERITY[cap] else rating


def apply_veto(rating: str, result: ValuationResult) -> tuple[str, Veto]:
    # multiples-only PS>30 veto (computed here since it needs no DCF)
    veto = result.veto
    if (not veto.triggered and result.data_quality == "multiples_only"
            and result.multiples and result.multiples.ps is not None
            and result.multiples.ps > _MULTIPLES_ONLY_MAX_PS):
        veto = Veto(triggered=True, rating_cap="hold",
                    reason=f"no positive FCF and P/S {result.multiples.ps:.1f} "
                           f"> {_MULTIPLES_ONLY_MAX_PS}x")
    if not veto.triggered or veto.rating_cap is None:
        return rating, veto
    return _cap_rating(rating, veto.rating_cap), veto
