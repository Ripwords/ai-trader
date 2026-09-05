from decimal import Decimal
from app.services.valuation.compose import value, apply_veto, RATING_SEVERITY, _compute_veto
from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod, Multiples, Veto, ValuationResult

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


def test_value_negative_equity_is_multiples_only_not_maximally_undervalued():
    """Net debt far above the discounted cash flows gives a negative equity
    value. That must not surface as MoS +100% with the veto silent."""
    vi = ValuationInput(symbol="X", current_price=D("150"), fcf_base=D("100"),
                        net_debt=D("100000"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(market_cap=D("1500"), ps_ratio=D("2"),
                                        free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "multiples_only"
    assert res.fair_value is None
    assert res.margin_of_safety_pct is None
    assert any("non-positive" in w for w in res.warnings)


def test_value_without_price_is_unavailable_not_a_bargain():
    """A missing price feed used to become current_price=0, MoS +100%, and
    the top row of the screener with data_quality='full'."""
    vi = ValuationInput(symbol="X", current_price=D("0"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(market_cap=D("1000"), ps_ratio=D("2"),
                                        free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "unavailable"
    assert res.fair_value is None
    assert res.margin_of_safety_pct is None


def test_value_carries_currency_and_price_note_into_the_result():
    vi = ValuationInput(symbol="X", current_price=D("100"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(), metrics=Metrics(),
                        currency="CNY", price_note="quote converted from HKD to CNY at 0.925")
    res = value(vi)
    assert res.currency == "CNY"
    assert any("HKD" in w for w in res.warnings)


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


# FIX 2: veto reason string accuracy
def test_veto_reason_says_1_5x_not_2x():
    vi = ValuationInput(symbol="X", current_price=D("1000"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.veto.triggered
    assert "1.5x" in (res.veto.reason or "")
    assert "2x" not in (res.veto.reason or "")


# FIX 3: historical_self_multiples wired via avg_price_by_period on ValuationInput
def test_historical_multiples_populated_via_avg_price_by_period():
    avg_prices = {"2024": D("120"), "2021": D("90")}
    vi = ValuationInput(
        symbol="X", current_price=D("120"), fcf_base=D("100"),
        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
        history=_history(),
        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10"),
                        market_cap=D("1200")),
        avg_price_by_period=avg_prices,
    )
    res = value(vi)
    assert res.historical_multiples is not None
    # history has revenue -> P/S should be computable
    assert res.historical_multiples.ps is not None


# FIX 4: verify_market_cap wired - mismatch appended to warnings
def test_market_cap_mismatch_produces_warning():
    # computed = 100 * 10 = 1000; reported = 2000 -> >1% discrepancy
    vi = ValuationInput(
        symbol="X", current_price=D("100"), fcf_base=D("100"),
        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
        history=_history(),
        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10"),
                        market_cap=D("2000")),
    )
    res = value(vi)
    assert any("market cap mismatch" in w for w in res.warnings)


def test_market_cap_match_no_mismatch_warning():
    # computed = 100 * 10 = 1000; reported = 1000 -> within tolerance
    vi = ValuationInput(
        symbol="X", current_price=D("100"), fcf_base=D("100"),
        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
        history=_history(),
        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10"),
                        market_cap=D("1000")),
    )
    res = value(vi)
    assert not any("market cap mismatch" in w for w in res.warnings)


# FIX 5: veto branch (b) — high implied growth, not branch (a)
def test_veto_branch_b_high_implied_growth():
    # Build a ValuationResult where MoS is -0.30 (branch a doesn't fire)
    # and reverse_dcf_implied_growth is 0.50 (> 2.5 * ~0.15 derived from _history())
    vi = ValuationInput(
        symbol="X", current_price=D("100"), fcf_base=D("100"),
        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
        history=_history(),
        metrics=Metrics(),
    )
    from app.services.valuation.assumptions import Assumptions
    fake_result = ValuationResult(
        symbol="X", current_price=D("100"), fair_value=D("143"),
        margin_of_safety_pct=D("-0.30"),  # price is 1.3x fair value — branch (a) threshold is -0.50
        scenarios=[], assumptions_used=None,
        multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=D("0.50"),  # well above 2.5 * 0.15 = 0.375
        data_quality="full",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=[],
    )
    veto = _compute_veto(vi, fake_result)
    assert veto.triggered is True
    assert veto.rating_cap == "hold"
    assert "growth" in (veto.reason or "").lower()


# FIX 5: apply_veto multiples-only PS>30 path
def test_apply_veto_multiples_only_high_ps_caps_to_hold():
    result = ValuationResult(
        symbol="X", current_price=D("100"), fair_value=None,
        margin_of_safety_pct=None, scenarios=[], assumptions_used=None,
        multiples=Multiples(ps=D("35")), historical_multiples=None,
        reverse_dcf_implied_growth=None, data_quality="multiples_only",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=[],
    )
    effective, veto = apply_veto("buy", result)
    assert effective == "hold"
    assert veto.triggered is True
    assert veto.reason is not None and ("P/S" in veto.reason or "35" in veto.reason)
