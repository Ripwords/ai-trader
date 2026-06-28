from decimal import Decimal
from app.services.valuation.compose import value, apply_veto, RATING_SEVERITY
from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

D = Decimal


def _history():
    return [
        HistoryPeriod(period="2024", fcf=D("100"), revenue=D("500"), net_income=D("80")),
        HistoryPeriod(period="2021", fcf=D("80"), revenue=D("400"), net_income=D("60")),
    ]


def test_value_full_quality_produces_three_scenarios():
    vi = ValuationInput(symbol="X", current_price=D("100"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.2"),
                        history=_history(),
                        metrics=Metrics(market_cap=D("1000"), ps_ratio=D("2"),
                                        free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "full"
    assert res.fair_value is not None
    assert len(res.scenarios) == 3
    assert res.reverse_dcf_implied_growth is not None


def test_value_negative_fcf_is_multiples_only_no_fabrication():
    vi = ValuationInput(symbol="X", current_price=D("100"), fcf_base=D("-50"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=[HistoryPeriod(period="2024", fcf=D("-50"))],
                        metrics=Metrics(ps_ratio=D("40"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "multiples_only"
    assert res.fair_value is None
    assert any("FCF" in w or "fcf" in w for w in res.warnings)


def test_apply_veto_caps_buy_to_hold_when_grossly_overvalued():
    vi = ValuationInput(symbol="X", current_price=D("1000"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)  # fair value ~150ish << 1000 -> MoS very negative
    effective, veto = apply_veto("strong-buy", res)
    assert veto.triggered is True
    assert effective == "hold"


def test_apply_veto_does_not_lift_sell():
    vi = ValuationInput(symbol="X", current_price=D("1000"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    effective, veto = apply_veto("sell", res)
    assert effective == "sell"  # cap never raises a bearish call


def test_rating_severity_ordering():
    assert RATING_SEVERITY["strong-buy"] > RATING_SEVERITY["hold"] > RATING_SEVERITY["sell"]
