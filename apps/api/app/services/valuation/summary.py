from __future__ import annotations

from app.services.valuation.models import ValuationResult


def format_valuation_for_agents(result: ValuationResult) -> str:
    if result.data_quality == "unavailable":
        return "## Deterministic Valuation\nValuation unavailable (data could not be retrieved)."
    lines = ["## Deterministic Valuation (DCF, computed — do not recompute by hand)"]
    if result.dcf_invalid_reason:
        lines.append(
            f"**DCF NOT VALID for this stock: {result.dcf_invalid_reason}.** No DCF "
            "fair value is stated and no valuation cap applies to the rating. Judge "
            "valuation on the multiples below and the business's own economics "
            "instead, and do not cite a DCF target."
        )
    if result.fair_value is not None:
        lines.append(f"- Fair value/share: {result.fair_value:.2f} "
                     f"(current price {result.current_price:.2f})")
    if result.margin_of_safety_pct is not None:
        lines.append(f"- Margin of safety: {result.margin_of_safety_pct:.1%}")
    if result.reverse_dcf_implied_growth is not None:
        lines.append(f"- Reverse-DCF implied growth (priced in): "
                     f"{result.reverse_dcf_implied_growth:.1%}")
    for s in result.scenarios:
        lines.append(f"  - {s.name}: growth {s.growth:.1%} → fair value {s.fair_value:.2f}")
    if result.multiples:
        hist = result.historical_multiples
        for label, key in (("P/E", "pe"), ("P/B", "pb"), ("P/S", "ps"), ("P/FCF", "p_fcf")):
            now = getattr(result.multiples, key)
            if now is None:
                continue
            past = getattr(hist, key) if hist else None
            own = f" (own history {past:.1f})" if past is not None else ""
            lines.append(f"- {label}: {now:.1f}{own}")
    if result.veto.triggered:
        lines.append(f"\n**VALUATION VETO: rating capped at {str(result.veto.rating_cap).upper()} "
                     f"— {result.veto.reason}.** You may argue against this in your rationale, "
                     f"but the cap will be applied and your dissent logged.")
    for w in result.warnings:
        if result.dcf_invalid_reason and result.dcf_invalid_reason in w:
            continue  # already stated above
        lines.append(f"- _note: {w}_")
    return "\n".join(lines)
