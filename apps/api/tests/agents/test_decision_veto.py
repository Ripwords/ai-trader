from decimal import Decimal as D

from app.services.agents.graph import _extract_decision
from app.services.valuation.models import ValuationResult, Veto


def _overvalued_result() -> ValuationResult:
    return ValuationResult(
        symbol="X",
        current_price=D("1000"),
        fair_value=D("150"),
        margin_of_safety_pct=D("-0.85"),
        scenarios=[],
        assumptions_used=None,
        multiples=None,
        historical_multiples=None,
        reverse_dcf_implied_growth=D("0.4"),
        data_quality="full",
        veto=Veto(triggered=True, reason="price >= 2x DCF fair value", rating_cap="hold"),
        warnings=[],
    )


def test_decision_capped_by_veto_preserves_original():
    prev = {"final_trade_decision": ""}
    curr = {"final_trade_decision": "FINAL TRANSACTION PROPOSAL: **BUY**"}
    dec = _extract_decision(prev, curr, valuation=_overvalued_result())
    assert dec["rating"] == "hold"
    assert dec["original_rating"] == "buy"
    assert dec["veto"]["rating_cap"] == "hold"


def test_decision_unchanged_without_veto():
    prev = {"final_trade_decision": ""}
    curr = {"final_trade_decision": "FINAL TRANSACTION PROPOSAL: **BUY**"}
    dec = _extract_decision(prev, curr, valuation=None)
    assert dec["rating"] == "buy"
    assert "original_rating" not in dec
