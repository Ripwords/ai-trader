from decimal import Decimal
from app.services.valuation.assumptions import (
    derive_growth, derive_discount_rate, build_default_assumptions,
)
from app.services.valuation.models import HistoryPeriod

D = Decimal


def test_derive_discount_rate_capm():
    # 0.04 + 1.2 * 0.05 = 0.10
    assert derive_discount_rate(D("1.2")) == D("0.10")


def test_derive_discount_rate_floor_and_ceiling():
    assert derive_discount_rate(D("0")) == D("0.07")     # 0.04 -> floored to 0.07
    assert derive_discount_rate(D("5")) == D("0.15")     # huge beta -> capped


def test_derive_growth_caps_and_haircut():
    # history newest-first like Yahoo: fcf 100 (2024) ... 80 (2021); 3 intervals
    hist = [
        HistoryPeriod(period="2024", fcf=D("100")),
        HistoryPeriod(period="2023", fcf=D("92")),
        HistoryPeriod(period="2022", fcf=D("86")),
        HistoryPeriod(period="2021", fcf=D("80")),
    ]
    g = derive_growth(hist)
    # CAGR = (100/80)^(1/3)-1 = 0.0772; *0.75 haircut = 0.0579
    assert g.quantize(D("0.0001")) == D("0.0579")


def test_derive_growth_compounds_over_calendar_years_not_point_count():
    """A gap (or a loss year that is filtered out) must not shorten the
    exponent: 80 -> 100 over 2021..2024 is three years of compounding
    whichever middle years survive the positive-FCF filter."""
    gapped = [HistoryPeriod(period="2024", fcf=D("100")), HistoryPeriod(period="2021", fcf=D("80"))]
    with_loss_year = [
        HistoryPeriod(period="2024", fcf=D("100")),
        HistoryPeriod(period="2023", fcf=D("-5")),
        HistoryPeriod(period="2022", fcf=D("90")),
        HistoryPeriod(period="2021", fcf=D("80")),
    ]
    assert derive_growth(gapped).quantize(D("0.0001")) == D("0.0579")
    assert derive_growth(with_loss_year).quantize(D("0.0001")) == D("0.0579")


def test_derive_growth_fallback_when_sparse():
    assert derive_growth([HistoryPeriod(period="2024", fcf=D("100"))]) == D("0.03")


def test_build_default_assumptions_shape():
    a = build_default_assumptions([HistoryPeriod(period="2024", fcf=D("100"))], D("1.0"))
    assert len(a.growth_rates) == 5
    assert a.terminal_growth == D("0.025")
