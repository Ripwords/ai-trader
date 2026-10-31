from decimal import Decimal
from app.services.valuation.summary import format_valuation_for_agents
from app.services.valuation.models import ValuationResult, Veto

D = Decimal


def test_summary_includes_fair_value_and_veto():
    res = ValuationResult(
        symbol="X", current_price=D("1000"), fair_value=D("150"),
        margin_of_safety_pct=D("-0.85"), scenarios=[], assumptions_used=None,
        multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=D("0.4"), data_quality="full",
        veto=Veto(triggered=True, reason="price >= 2x DCF fair value", rating_cap="hold"),
        warnings=[])
    out = format_valuation_for_agents(res)
    assert "150" in out
    assert "VETO" in out.upper()


def test_summary_handles_unavailable():
    res = ValuationResult(
        symbol="X", current_price=D("0"), fair_value=None, margin_of_safety_pct=None,
        scenarios=[], assumptions_used=None, multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=None, data_quality="unavailable",
        veto=Veto(triggered=False, reason=None, rating_cap=None), warnings=["n/a"])
    out = format_valuation_for_agents(res)
    assert "unavailable" in out.lower()


def test_summary_lists_every_multiple_against_its_own_history():
    """A bank's DCF is invalid and it is judged on P/B and P/E, so those must
    reach the agents, not only P/S."""
    from app.services.valuation.models import Multiples
    res = ValuationResult(
        symbol="HK.00005", current_price=D("17.3"), fair_value=None, margin_of_safety_pct=None,
        scenarios=[], assumptions_used=None,
        multiples=Multiples(pe=D("11.35"), pb=D("1.71"), ps=D("4.39"), p_fcf=None),
        historical_multiples=Multiples(pe=D("11.54"), pb=None, ps=D("3.43"), p_fcf=None),
        reverse_dcf_implied_growth=None, data_quality="multiples_only",
        veto=Veto(triggered=False, reason=None, rating_cap=None), warnings=[],
        dcf_invalid_reason="the company is in Banks - Diversified, ...")
    out = format_valuation_for_agents(res)
    assert "- P/E: 11.4 (own history 11.5)" in out
    assert "- P/B: 1.7" in out
    assert "- P/S: 4.4 (own history 3.4)" in out
    assert "P/FCF" not in out
    assert "operating-cash-flow trajectory" not in out
