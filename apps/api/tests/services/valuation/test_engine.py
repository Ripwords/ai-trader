from decimal import Decimal
from app.services.valuation.engine import dcf, margin_of_safety, reverse_dcf

D = Decimal


def _q(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"))


def test_dcf_two_stage_golden():
    fv = dcf(D("100"), [D("0.10"), D("0.10")], D("0.10"), D("0.025"), D("0"), D("10"))
    assert _q(fv) == D("156.67")


def test_margin_of_safety_quarter():
    mos = margin_of_safety(D("156.666667"), D("117.50"))
    assert mos.quantize(D("0.0001")) == D("0.2500")


def test_margin_of_safety_overvalued_is_negative():
    mos = margin_of_safety(D("100"), D("150"))
    assert mos < 0


def test_reverse_dcf_roundtrip():
    # dcf at 12% flat growth -> fair value F; reverse_dcf(F) ~= 0.12
    fv = dcf(D("100"), [D("0.12")] * 5, D("0.10"), D("0.025"), D("0"), D("10"))
    implied = reverse_dcf(fv, D("100"), D("0.10"), D("0.025"), D("0"), D("10"),
                          explicit_years=5)
    assert abs(implied - D("0.12")) < D("0.001")
