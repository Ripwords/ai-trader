from decimal import Decimal
from app.services.valuation.engine import current_multiples, historical_self_multiples
from app.services.valuation.models import Metrics, HistoryPeriod

D = Decimal


def test_current_multiples_passthrough_and_pfcf():
    m = Metrics(market_cap=D("1000"), pe_ratio=D("20"), pb_ratio=D("5"),
                ps_ratio=D("4"), free_cash_flow=D("50"), shares_outstanding=D("10"))
    out = current_multiples(m, price=D("100"))
    assert out.pe == D("20")
    assert out.ps == D("4")
    assert out.p_fcf == D("20")  # market_cap / fcf = 1000/50


def test_historical_self_multiples_median_ps():
    hist = [
        HistoryPeriod(period="2023", revenue=D("100")),
        HistoryPeriod(period="2024", revenue=D("200")),
    ]
    # shares=10; avg price 2023=50 -> mcap 500 / rev 100 = PS 5
    #            avg price 2024=40 -> mcap 400 / rev 200 = PS 2
    out = historical_self_multiples(hist, shares=D("10"),
                                    avg_price_by_period={"2023": D("50"), "2024": D("40")})
    assert out.ps == D("3.5")  # median of [5, 2]


def test_p_fcf_uses_the_dcf_base_when_given():
    """MSFT: market cap over Yahoo's levered 2.99B gave P/FCF 1294; over the
    60B of OCF − capex the DCF uses it is about 65."""
    m = Metrics(market_cap=D("3880"), free_cash_flow=D("3"))
    assert current_multiples(m, price=D("1"), fcf=D("60")).p_fcf == D("3880") / D("60")
    assert current_multiples(m, price=D("1"), fcf=D("-5")).p_fcf is None


def test_historical_pe_skips_loss_years():
    """A loss year has no P/E; a negative one would drag the median below the
    profitable years the company actually traded on."""
    hist = [
        HistoryPeriod(period="2022", net_income=D("-50")),
        HistoryPeriod(period="2023", net_income=D("-40")),
        HistoryPeriod(period="2024", net_income=D("50")),
    ]
    prices = {"2022": D("100"), "2023": D("100"), "2024": D("100")}
    out = historical_self_multiples(hist, shares=D("10"), avg_price_by_period=prices)
    assert out.pe == D("20")
