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
