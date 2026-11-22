"""Out-of-regime DCF guard.

Triggered by an AMZN run after its Q3 2026 print: Yahoo's
``financialData.freeCashflow`` (levered FCF, +$3.22B) fed the DCF as the
base FCF while trailing OCF − capex was −$46.9B. The DCF produced a fair
value of ~$3.6/share against a $254.60 price, and that number then fed the
"price >= 1.5x fair value" veto that capped the debate's rating at HOLD.

A DCF that far out of its regime says nothing about the stock; it must be
marked invalid, explain why, and never cap the rating.
"""

from decimal import Decimal as D

from app.services.valuation.compose import apply_veto, value
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput
from app.services.valuation.summary import format_valuation_for_agents


def _amzn(**overrides) -> ValuationInput:
    base = dict(
        symbol="AMZN",
        current_price=D("254.60"),
        fcf_base=D("3219124992"),
        net_debt=D("0"),
        shares_outstanding=D("10811000000"),
        beta=D("1.38"),
        history=[
            HistoryPeriod(period="2025", revenue=D("716924000000"), net_income=D("77670000000")),
            HistoryPeriod(period="2024", revenue=D("637959000000"), net_income=D("59248000000")),
            HistoryPeriod(period="2023", revenue=D("574785000000"), net_income=D("30425000000")),
        ],
        metrics=Metrics(
            market_cap=D("2752000000000"), ps_ratio=D("3.35"),
            free_cash_flow=D("3219124992"), shares_outstanding=D("10811000000"),
        ),
    )
    base.update(overrides)
    return ValuationInput(**base)


def _healthy(price: str) -> ValuationInput:
    """A DCF in its regime: FCF 20% of revenue, fair value ~ low hundreds."""
    return ValuationInput(
        symbol="OK", current_price=D(price), fcf_base=D("100"), net_debt=D("0"),
        shares_outstanding=D("10"), beta=D("1.0"),
        history=[
            HistoryPeriod(period="2025", fcf=D("100"), revenue=D("500")),
            HistoryPeriod(period="2022", fcf=D("80"), revenue=D("400")),
        ],
        metrics=Metrics(market_cap=D(price) * 10, ps_ratio=D("2"),
                        free_cash_flow=D("100"), shares_outstanding=D("10")),
    )


def test_amzn_near_zero_fcf_marks_dcf_invalid_without_a_fair_value():
    r = value(_amzn())
    assert r.fair_value is None
    assert r.margin_of_safety_pct is None
    assert r.scenarios == []
    assert r.reverse_dcf_implied_growth is None
    assert r.data_quality == "multiples_only"
    assert r.dcf_invalid_reason is not None
    assert "near zero" in r.dcf_invalid_reason
    assert "revenue" in r.dcf_invalid_reason


def test_amzn_invalid_dcf_does_not_cap_a_buy():
    r = value(_amzn())
    assert r.veto.triggered is False
    rating, veto = apply_veto("buy", r)
    assert rating == "buy"
    assert veto.triggered is False


def test_negative_ttm_fcf_conflicting_with_positive_base_marks_dcf_invalid():
    # Base FCF looks healthy (5% of revenue) but trailing OCF − capex is
    # negative: the base is stale or a different definition.
    vi = _amzn(fcf_base=D("36000000000"), fcf_ttm=D("-46892000000"),
               fcf_ttm_period="TTM to 2026-09-30")
    r = value(vi)
    assert r.fair_value is None
    assert r.veto.triggered is False
    assert r.dcf_invalid_reason is not None
    assert "-46.89B" in r.dcf_invalid_reason
    assert "TTM to 2026-09-30" in r.dcf_invalid_reason


def test_fair_value_far_below_the_price_is_out_of_regime():
    r = value(_healthy("20000"))
    assert r.fair_value is None
    assert r.veto.triggered is False
    assert r.dcf_invalid_reason is not None
    assert "of the price" in r.dcf_invalid_reason


def test_fair_value_above_5x_price_is_out_of_regime():
    r = value(_healthy("5"))
    assert r.fair_value is None
    assert r.dcf_invalid_reason is not None
    assert "of the price" in r.dcf_invalid_reason
    rating, _ = apply_veto("strong-buy", r)
    assert rating == "strong-buy"


def test_in_regime_overvaluation_backed_by_own_multiples_still_vetoes():
    # Fair value ~0.5x price and P/S 2.0 against 1.0 of its own: overvalued
    # inside the regime on both counts, so the rating is capped.
    fv = value(_healthy("100")).fair_value
    assert fv is not None
    r = value(_healthy(str((fv * 2).quantize(D("0.01")))).model_copy(
        update={"avg_price_by_period": {"2025": D("50")}}))
    assert r.dcf_invalid_reason is None
    assert r.fair_value is not None
    assert r.veto.triggered is True
    rating, _ = apply_veto("buy", r)
    assert rating == "hold"


def test_agent_summary_explains_the_invalid_dcf_and_that_no_cap_applies():
    out = format_valuation_for_agents(value(_amzn()))
    assert "DCF NOT VALID" in out
    assert "near zero" in out
    assert "no valuation cap" in out.lower()
    assert "VETO" not in out
    assert "Fair value/share" not in out


def test_bank_dcf_is_out_of_regime_and_names_the_industry():
    """HSBC got a $58 fair value on a $17.30 price: a bank's operating cash
    flow moves with deposits and loans, so OCF − capex is not free cash flow."""
    r = value(_healthy("100").model_copy(update={"industry": "Banks - Diversified"}))
    assert r.fair_value is None
    assert r.data_quality == "multiples_only"
    assert r.dcf_invalid_reason and "Banks - Diversified" in r.dcf_invalid_reason
    assert "P/B" in r.dcf_invalid_reason


def test_insurers_and_brokers_are_out_of_regime_but_card_networks_are_not():
    for industry in ("Insurance - Life", "Capital Markets", "Banks - Regional"):
        assert value(_healthy("100").model_copy(update={"industry": industry})).fair_value is None
    assert value(_healthy("100").model_copy(update={"industry": "Credit Services"})).fair_value is not None
    assert value(_healthy("100")).fair_value is not None


def test_bank_with_negative_fcf_gets_the_bank_reason_not_the_fcf_one():
    vi = _healthy("100").model_copy(update={"industry": "Banks - Diversified", "fcf_base": D("-5")})
    r = value(vi)
    assert r.dcf_invalid_reason and "Banks - Diversified" in r.dcf_invalid_reason
    assert not any("non-positive FCF" in w for w in r.warnings)
