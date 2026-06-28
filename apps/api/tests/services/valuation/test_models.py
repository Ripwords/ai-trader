from decimal import Decimal
from app.services.valuation.models import (
    Assumptions, HistoryPeriod, Metrics, ValuationInput, ValuationResult, Veto,
)


def test_valuation_result_minimal_unavailable():
    res = ValuationResult(
        symbol="AAPL",
        current_price=Decimal("100"),
        fair_value=None,
        margin_of_safety_pct=None,
        scenarios=[],
        assumptions_used=None,
        multiples=None,
        historical_multiples=None,
        reverse_dcf_implied_growth=None,
        data_quality="unavailable",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=["no data"],
    )
    assert res.symbol == "AAPL"
    assert res.fair_value is None
    assert res.data_quality == "unavailable"


def test_valuation_input_decimal_coercion():
    vi = ValuationInput(
        symbol="AAPL",
        current_price=Decimal("190.50"),
        fcf_base=Decimal("100000000000"),
        net_debt=Decimal("0"),
        shares_outstanding=Decimal("15000000000"),
        beta=Decimal("1.2"),
        history=[HistoryPeriod(period="2024", revenue=Decimal("1"), net_income=None,
                               fcf=Decimal("100"), total_debt=None, shareholders_equity=None)],
        metrics=Metrics(market_cap=Decimal("3e12"), pe_ratio=None, pb_ratio=None,
                        ps_ratio=Decimal("7"), eps=None, free_cash_flow=Decimal("1e11"),
                        shares_outstanding=Decimal("15e9"), beta=Decimal("1.2")),
    )
    assert vi.beta == Decimal("1.2")
    assert isinstance(vi.fcf_base, Decimal)
