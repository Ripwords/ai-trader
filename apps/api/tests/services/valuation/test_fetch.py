from decimal import Decimal
from app.services.valuation.fetch import to_valuation_input, avg_close_by_year

D = Decimal


def test_avg_close_by_year_buckets_and_averages():
    bars = [
        {"time": "2023-01-02", "close": 10},
        {"time": "2023-06-02", "close": 20},
        {"time": "2024-01-02", "close": 40},
    ]
    out = avg_close_by_year(bars)
    assert out["2023"] == D("15")
    assert out["2024"] == D("40")


def test_to_valuation_input_uses_metrics_fcf_and_maps_history():
    payload = {
        "symbol": "AAPL",
        "metrics": {"market_cap": 1000, "free_cash_flow": 100, "shares_outstanding": 10,
                    "beta": 1.2, "ps_ratio": 5},
        "history": [{"period": "2024", "fcf": 100, "revenue": 500, "net_income": 80,
                     "total_debt": 50}],
        "dailyBars": [{"time": "2024-01-02", "close": 100}],
    }
    vi = to_valuation_input("AAPL", payload)
    assert vi.symbol == "AAPL"
    assert vi.fcf_base == D("100")
    assert vi.shares_outstanding == D("10")
    assert vi.current_price == D("100")   # newest close
    assert vi.beta == D("1.2")


def test_to_valuation_input_missing_data_degrades():
    vi = to_valuation_input("X", {"symbol": "X", "metrics": {}, "history": [], "dailyBars": []})
    assert vi.fcf_base is None
    assert vi.shares_outstanding is None
