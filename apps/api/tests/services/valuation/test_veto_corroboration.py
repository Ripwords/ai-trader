"""The DCF's rating cap on the owner's core holdings.

On 2026-10-31 the stored valuations for AAPL, MSFT, NVDA and V all carried a
"price >= 1.5x DCF fair value" veto, which caps the debate's rating at HOLD.
AAPL (fair value 106.11 against 344.63) and MSFT (116.21 against 521.91) also
carried the engine's own "treat the fair value as out-of-regime" warning, yet
kept both the fair value and the veto.

The inputs below are rebuilt per share from those stored results (the table
keeps results, not inputs): shares are 1, the FCF base comes from the stored
P/FCF, and net debt is whatever makes the engine's DCF land on the stored
fair value under the stored growth and discount rate.
"""

from dataclasses import dataclass
from decimal import Decimal as D

import pytest

from app.services.valuation.assumptions import TERMINAL_GROWTH, build_default_assumptions
from app.services.valuation.compose import _compute_veto, apply_veto, value
from app.services.valuation.engine import dcf
from app.services.valuation.models import (
    HistoryPeriod, Metrics, ValuationInput, ValuationResult, Veto,
)
from app.services.valuation.summary import format_valuation_for_agents


@dataclass(frozen=True)
class Stored:
    price: D
    fair_value: D
    growth: D
    discount: D
    pe: D
    ps: D
    hist_pe: D
    hist_ps: D
    p_fcf: D | None


STORED = {
    "US.AAPL": Stored(D("344.630005"), D("106.112426"), D("-0.029587976"), D("0.09345"),
                      D("39.52179"), D("10.774089"), D("35.700371"), D("9.608778"),
                      D("46.690538")),
    # The stored MSFT P/FCF predates the OCF − capex base, so it is not used.
    "US.MSFT": Stored(D("521.909973"), D("116.209026"), D("0.030332969"), D("0.09495"),
                      D("27.239561"), D("11.18736"), D("30.117378"), D("11.393740"), None),
    "US.NVDA": Stored(D("204.639999"), D("69.410039"), D("0.15"), D("0.15"),
                      D("25.87105"), D("16.310003"), D("51.250530"), D("28.572147"),
                      D("118.188387")),
    "US.V": Stored(D("413.589996"), D("244.449835"), D("0.034996601"), D("0.07855"),
                   D("33.570618"), D("16.839905"), D("27.147362"), D("13.746280"),
                   D("36.603296")),
}


def _rebuild(symbol: str, **changes) -> ValuationInput:
    s = STORED[symbol]
    cagr = s.growth / D("0.75")
    revenue = s.price / s.ps
    avg_price = s.hist_ps * revenue
    history = [
        HistoryPeriod(period="2026", fcf=D("1") + cagr, revenue=revenue,
                      net_income=avg_price / s.hist_pe),
        HistoryPeriod(period="2025", fcf=D("1")),
    ]
    beta = (s.discount - D("0.04")) / D("0.05")
    rates = [s.growth] * 5
    unit = dcf(D("1"), rates, s.discount, TERMINAL_GROWTH, D("0"), D("1"))
    if s.p_fcf is None:
        fcf_base, net_debt = s.fair_value / unit, D("0")
    else:
        fcf_base = s.price / s.p_fcf
        net_debt = fcf_base * unit - s.fair_value
    vi = ValuationInput(
        symbol=symbol, current_price=s.price, fcf_base=fcf_base, net_debt=net_debt,
        shares_outstanding=D("1"), beta=beta, history=history,
        metrics=Metrics(market_cap=s.price, pe_ratio=s.pe, ps_ratio=s.ps,
                        shares_outstanding=D("1"), beta=beta),
        avg_price_by_period={"2026": avg_price},
    )
    return vi.model_copy(update=changes)


@pytest.mark.parametrize("symbol", sorted(STORED))
def test_rebuilt_inputs_land_on_the_stored_assumptions_and_fair_value(symbol):
    s, vi = STORED[symbol], _rebuild(symbol)
    a = build_default_assumptions(vi.history, vi.beta)
    assert abs(a.growth_rates[0] - s.growth) < D("0.000001")
    assert a.discount_rate == s.discount
    assert vi.fcf_base is not None and vi.shares_outstanding is not None
    fv = dcf(vi.fcf_base, a.growth_rates, a.discount_rate, a.terminal_growth,
             vi.net_debt, vi.shares_outstanding)
    assert abs(fv - s.fair_value) < D("0.01")


@pytest.mark.parametrize("symbol", ["US.AAPL", "US.MSFT"])
def test_price_at_or_above_3x_fair_value_discards_the_dcf(symbol):
    r = value(_rebuild(symbol))
    assert r.fair_value is None
    assert r.margin_of_safety_pct is None
    assert r.scenarios == []
    assert r.data_quality == "multiples_only"
    assert r.dcf_invalid_reason is not None and "of the price" in r.dcf_invalid_reason
    assert r.veto.triggered is False
    assert apply_veto("buy", r)[0] == "buy"


def test_out_of_regime_is_stated_once_not_as_a_second_warning():
    r = value(_rebuild("US.AAPL"))
    assert len([w for w in r.warnings if "regime" in w]) == 1
    assert not any("not a precise target" in w for w in r.warnings)


def test_regime_boundary_is_a_price_of_exactly_3x_fair_value():
    fv = STORED["US.NVDA"].fair_value
    inside = value(_rebuild("US.NVDA", current_price=fv * D("2.99")))
    edge = value(_rebuild("US.NVDA", current_price=fv * D("3.01")))
    assert inside.fair_value is not None
    assert edge.fair_value is None and edge.dcf_invalid_reason is not None


@pytest.mark.parametrize("symbol,fair_value", [("US.NVDA", "69.41"), ("US.V", "244.45")])
def test_dcf_alone_does_not_cap_a_stock_trading_near_its_own_multiples(symbol, fair_value):
    r = value(_rebuild(symbol))
    assert r.fair_value is not None
    assert r.fair_value.quantize(D("0.01")) == D(fair_value)
    assert r.margin_of_safety_pct is not None and r.margin_of_safety_pct <= D("-0.50")
    assert r.veto.triggered is False
    assert r.veto.corroboration == "not_corroborated"
    assert apply_veto("buy", r)[0] == "buy"
    note = next(w for w in r.warnings if "not applied as a rating cap" in w)
    assert "price >= 1.5x DCF fair value" in note
    assert "P/E" in note and "P/S" in note


def test_stretched_own_multiple_corroborates_the_dcf_and_caps_the_rating():
    s = STORED["US.V"]
    # Visa at 1.6x its own P/E: revenue kept, earnings history raised.
    vi = _rebuild("US.V")
    cheaper_history = vi.history[0].model_copy(
        update={"net_income": vi.avg_price_by_period["2026"] / (s.pe / D("1.6"))})
    r = value(vi.model_copy(update={"history": [cheaper_history, vi.history[1]]}))
    assert r.veto.triggered is True
    assert r.veto.rating_cap == "hold"
    assert r.veto.corroboration == "corroborated"
    assert "price >= 1.5x DCF fair value" in (r.veto.reason or "")
    assert "P/E" in (r.veto.reason or "") and "1.6x" in (r.veto.reason or "")
    assert apply_veto("strong-buy", r)[0] == "hold"
    assert not any("not applied as a rating cap" in w for w in r.warnings)


def test_missing_own_multiples_leave_the_dcf_signal_unverified_and_say_so():
    r = value(_rebuild("US.V", avg_price_by_period=None))
    assert r.historical_multiples is None
    assert r.veto.triggered is False
    assert r.veto.corroboration == "unavailable"
    assert apply_veto("buy", r)[0] == "buy"
    note = next(w for w in r.warnings if "not applied as a rating cap" in w)
    assert "unverified" in note
    assert "unverified" in format_valuation_for_agents(r)


def test_non_positive_own_multiple_is_not_a_comparison():
    vi = _rebuild("US.V")
    loss = vi.history[0].model_copy(update={"net_income": D("-1"), "revenue": None})
    r = value(vi.model_copy(update={"history": [loss, vi.history[1]]}))
    assert r.veto.corroboration == "unavailable"


def test_no_dcf_signal_has_no_corroboration_state():
    fv = STORED["US.V"].fair_value
    r = value(_rebuild("US.V", current_price=fv))
    assert r.veto.triggered is False
    assert r.veto.corroboration is None
    assert not any("not applied as a rating cap" in w for w in r.warnings)


def test_implied_growth_signal_needs_the_same_corroboration():
    # NVDA's price implies 47% growth against a 15% base: the reverse-DCF
    # trigger would fire on its own if only the margin-of-safety one were gated.
    vi = _rebuild("US.NVDA")
    r = value(vi)
    assert r.reverse_dcf_implied_growth is not None
    assert r.reverse_dcf_implied_growth > D("2.5") * D("0.15")
    mild = ValuationResult(**{
        **r.model_dump(), "margin_of_safety_pct": D("-0.30"),
        "veto": Veto(triggered=False, reason=None, rating_cap=None), "warnings": [],
    })
    veto, note = _compute_veto(vi, mild)
    assert veto.triggered is False
    assert veto.corroboration == "not_corroborated"
    assert note is not None and "growth" in note
