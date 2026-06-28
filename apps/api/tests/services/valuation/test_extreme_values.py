"""Regression tests for extreme / anomalous valuation handling.

Triggered by a live US.MU (Micron) result where Yahoo returned a price
(~$1,132) ~10x the company's FCF/revenue fundamentals (an unadjusted-split
data anomaly). The engine produced uninterpretable output: a saturated
reverse-DCF implied growth shown as a precise 99.9%, a -1880% margin of
safety, and a veto reason that formatted MoS as a bare fraction while the
card showed a percent. These tests pin the fixes.
"""

from decimal import Decimal as D

from app.services.valuation.engine import reverse_dcf
from app.services.valuation.compose import value
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput


def _anomalous_mu() -> ValuationInput:
    # Real-shaped Micron inputs: price ~10x the FCF fundamentals.
    return ValuationInput(
        symbol="US.MU",
        current_price=D("1132.33"),
        fcf_base=D("7639499776"),
        net_debt=D("0"),
        shares_outstanding=D("1129393151"),
        beta=D("1.2"),
        history=[
            HistoryPeriod(period="2025", fcf=D("7639499776"), revenue=D("37000000000")),
            HistoryPeriod(period="2021", fcf=D("8000000000"), revenue=D("27000000000")),
        ],
        metrics=Metrics(
            market_cap=D("1278845648896"), free_cash_flow=D("7639499776"),
            shares_outstanding=D("1129393151"), beta=D("1.2"),
        ),
    )


def test_reverse_dcf_returns_none_when_price_unreachable():
    # A price no growth in [-50%, +100%] can justify -> None, not the bound.
    implied = reverse_dcf(
        D("100000"), D("1"), D("0.10"), D("0.025"), D("0"), D("1"), explicit_years=5
    )
    assert implied is None


def test_reverse_dcf_still_solves_normal_case():
    # Sanity: a reachable target still returns a real, non-edge growth.
    from app.services.valuation.engine import dcf
    fv = dcf(D("100"), [D("0.12")] * 5, D("0.10"), D("0.025"), D("0"), D("10"))
    implied = reverse_dcf(fv, D("100"), D("0.10"), D("0.025"), D("0"), D("10"),
                          explicit_years=5)
    assert implied is not None
    assert abs(implied - D("0.12")) < D("0.001")


def test_anomalous_value_does_not_emit_saturated_growth():
    r = value(_anomalous_mu())
    # A real solved growth may surface (e.g. ~76%), but the misleading
    # saturated edge (~99.9%, the +100% search ceiling) must never appear.
    g = r.reverse_dcf_implied_growth
    assert g is None or g < D("0.99")


def test_anomalous_value_warns_about_divergence():
    r = value(_anomalous_mu())
    joined = " ".join(r.warnings).lower()
    assert "fair value" in joined
    assert ("anomaly" in joined or "out-of-regime" in joined or "out of regime" in joined)


def test_veto_reason_formats_mos_as_percent():
    r = value(_anomalous_mu())
    assert r.veto.triggered
    # MoS must be a percentage (matches the card), not a bare fraction.
    assert "%" in r.veto.reason
