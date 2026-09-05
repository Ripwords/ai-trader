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


def test_net_debt_subtracts_cash():
    payload = {
        "symbol": "AAPL",
        "metrics": {"free_cash_flow": 100, "shares_outstanding": 10},
        "history": [{"period": "2024", "fcf": 100, "total_debt": 100_000, "cash": 60_000}],
        "dailyBars": [{"time": "2024-01-02", "close": 100}],
    }
    vi = to_valuation_input("AAPL", payload)
    assert vi.net_debt == D("40000")
    assert vi.history[0].cash == D("60000")


def test_net_cash_balance_sheet_gives_negative_net_debt():
    payload = {
        "symbol": "X",
        "metrics": {},
        "history": [{"period": "2024", "fcf": 10, "total_debt": None, "cash": 500}],
        "dailyBars": [],
    }
    assert to_valuation_input("X", payload).net_debt == D("-500")


def test_price_conversion_sets_currency_and_note():
    payload = {
        "symbol": "HK.00700",
        "metrics": {"currency": "HKD", "financial_currency": "CNY"},
        "history": [],
        "dailyBars": [{"time": "2024-01-02", "close": 92.5}],
        "price_conversion": {"from": "HKD", "to": "CNY", "rate": 0.925},
    }
    vi = to_valuation_input("HK.00700", payload)
    assert vi.currency == "CNY"
    assert vi.price_note is not None and "HKD" in vi.price_note and "CNY" in vi.price_note


def test_price_conversion_failure_is_disclosed():
    payload = {
        "symbol": "HK.00700",
        "metrics": {"currency": "HKD", "financial_currency": "CNY"},
        "history": [],
        "dailyBars": [],
        "price_conversion": None,
        "price_conversion_error": "quote is in HKD but statements are in CNY and no FX rate was available",
    }
    vi = to_valuation_input("HK.00700", payload)
    assert vi.currency == "CNY"
    assert vi.price_note is not None and "different currencies" in vi.price_note


def test_to_valuation_input_missing_data_degrades():
    vi = to_valuation_input("X", {"symbol": "X", "metrics": {}, "history": [], "dailyBars": []})
    assert vi.fcf_base is None
    assert vi.shares_outstanding is None
