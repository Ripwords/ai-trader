from decimal import Decimal
from app.services.valuation.verify import cross_source_check, verify_market_cap

D = Decimal


def test_cross_source_within_tolerance():
    ok, msg = cross_source_check({"yahoo": D("100"), "moomoo": D("100.5")})
    assert ok is False  # not discrepant
    assert msg is None


def test_cross_source_exceeds_one_percent():
    discrepant, msg = cross_source_check({"yahoo": D("100"), "moomoo": D("103")})
    assert discrepant is True
    assert "3" in msg or "%" in msg


def test_verify_market_cap_matches():
    ok, _ = verify_market_cap(D("100"), D("10"), reported=D("1000"))
    assert ok is True


def test_verify_market_cap_mismatch():
    ok, msg = verify_market_cap(D("100"), D("10"), reported=D("2000"))
    assert ok is False
    assert msg is not None
