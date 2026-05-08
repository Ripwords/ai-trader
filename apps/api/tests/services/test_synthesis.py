from __future__ import annotations

import math
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.deps import get_opend
from app.main import create_app
from app.schemas.quote import Bar, KLineResponse
from app.schemas.synthesis import PortfolioSnapshot, Signal
from app.services.synthesis.portfolio_manager import decide_from_prices
from app.services.synthesis.risk_manager import compute_risk_sizing_from_closes
from app.settings import get_settings


def _flat_closes(price: float = 100.0, n: int = 60) -> list[float]:
    return [price] * n


def _high_vol_closes(start: float = 100.0, n: int = 60, log_step: float = 0.05) -> list[float]:
    closes = [start]
    for i in range(1, n):
        closes.append(closes[-1] * math.exp(log_step if i % 2 else -log_step))
    return closes


# --- risk manager ---------------------------------------------------------


def test_low_vol_uses_low_bucket_25pct():
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    sizing = compute_risk_sizing_from_closes("AAPL.US", portfolio, _flat_closes())
    assert sizing.volatility_bucket == "low"
    assert sizing.max_position_pct == 25.0


def test_high_vol_uses_smaller_max_pct():
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    sizing = compute_risk_sizing_from_closes("VOL.US", portfolio, _high_vol_closes())
    assert sizing.volatility_bucket == "very_high"
    assert sizing.max_position_pct == 10.0
    assert sizing.max_position_pct < 25.0


def test_correlation_multiplier_first_position_boost():
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    sizing = compute_risk_sizing_from_closes("X.US", portfolio, _flat_closes())
    assert sizing.correlation_multiplier == 1.10


def test_correlation_multiplier_small_portfolio():
    portfolio = PortfolioSnapshot(
        cash=50_000,
        total_value=100_000,
        positions={"A.US": 25_000, "B.US": 25_000},
    )
    sizing = compute_risk_sizing_from_closes("X.US", portfolio, _flat_closes())
    assert sizing.correlation_multiplier == 1.0


def test_correlation_multiplier_diversified_portfolio_haircut():
    portfolio = PortfolioSnapshot(
        cash=10_000,
        total_value=100_000,
        positions={"A.US": 20_000, "B.US": 20_000, "C.US": 20_000, "D.US": 20_000},
    )
    sizing = compute_risk_sizing_from_closes("X.US", portfolio, _flat_closes())
    assert sizing.correlation_multiplier == 0.85


def test_remaining_capped_by_cash():
    portfolio = PortfolioSnapshot(cash=1_000, total_value=100_000, positions={})
    sizing = compute_risk_sizing_from_closes("X.US", portfolio, _flat_closes())
    assert sizing.remaining_position_usd == 1_000


def test_remaining_subtracts_current_position():
    portfolio = PortfolioSnapshot(
        cash=100_000, total_value=100_000, positions={"X.US": 20_000}
    )
    sizing = compute_risk_sizing_from_closes("X.US", portfolio, _flat_closes())
    # 100k * 25% * 1.10 = 27_500; minus held 20_000 = 7_500
    assert sizing.max_position_usd == pytest.approx(27_500.0)
    assert sizing.remaining_position_usd == pytest.approx(7_500.0)


# --- portfolio manager fallback -------------------------------------------


def test_fallback_three_bullish_high_conf_buys_with_positive_qty():
    signals = [
        Signal(source="a", symbol="X.US", signal="bullish", confidence=80, reasoning=""),
        Signal(source="b", symbol="X.US", signal="bullish", confidence=80, reasoning=""),
        Signal(source="c", symbol="X.US", signal="bullish", confidence=80, reasoning=""),
    ]
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    res = decide_from_prices(["X.US"], signals, portfolio, {"X.US": _flat_closes(100.0)})
    d = res.decisions[0]
    assert d.action == "buy"
    assert d.quantity > 0


def test_fallback_three_bearish_with_position_sells():
    signals = [
        Signal(source="a", symbol="X.US", signal="bearish", confidence=80, reasoning=""),
        Signal(source="b", symbol="X.US", signal="bearish", confidence=80, reasoning=""),
        Signal(source="c", symbol="X.US", signal="bearish", confidence=80, reasoning=""),
    ]
    portfolio = PortfolioSnapshot(
        cash=10_000, total_value=110_000, positions={"X.US": 10_000}
    )
    res = decide_from_prices(["X.US"], signals, portfolio, {"X.US": _flat_closes(100.0)})
    d = res.decisions[0]
    assert d.action == "sell"
    assert d.quantity == 100  # 10_000 / 100


def test_fallback_mixed_signals_holds():
    signals = [
        Signal(source="a", symbol="X.US", signal="bullish", confidence=70, reasoning=""),
        Signal(source="b", symbol="X.US", signal="bearish", confidence=70, reasoning=""),
        Signal(source="c", symbol="X.US", signal="neutral", confidence=70, reasoning=""),
    ]
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    res = decide_from_prices(["X.US"], signals, portfolio, {"X.US": _flat_closes(100.0)})
    d = res.decisions[0]
    assert d.action == "hold"


def test_fallback_no_signals_for_symbol_prefilled_hold():
    signals = [
        Signal(source="a", symbol="Y.US", signal="bullish", confidence=80, reasoning=""),
    ]
    portfolio = PortfolioSnapshot(cash=100_000, total_value=100_000, positions={})
    res = decide_from_prices(["X.US"], signals, portfolio, {"X.US": _flat_closes(100.0)})
    d = res.decisions[0]
    assert d.action == "hold"
    assert d.quantity == 0
    assert d.confidence == 0


class _FakeKlineAdapter:
    """Returns a flat 60-bar series so risk math is deterministic."""

    def get_kline(self, code: str, *, ktype: str, num: int) -> KLineResponse:
        t0 = datetime(2026, 1, 1)
        bars = [
            Bar(
                time=t0 + timedelta(days=i),
                open=100.0,
                high=100.0,
                low=100.0,
                close=100.0,
                volume=1000,
                turnover=100_000.0,
            )
            for i in range(num)
        ]
        return KLineResponse(code=code, ktype=ktype, bars=bars)


def _client_with_fake_kline(monkeypatch) -> TestClient:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: _FakeKlineAdapter()
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    return c


def test_risk_endpoint_returns_sizing(monkeypatch):
    c = _client_with_fake_kline(monkeypatch)
    try:
        res = c.post(
            "/synthesis/risk",
            json={
                "symbol": "X.US",
                "portfolio": {"cash": 100_000, "total_value": 100_000, "positions": {}},
            },
        )
        assert res.status_code == 200
        body = res.json()
        assert body["volatility_bucket"] == "low"
        assert body["max_position_pct"] == 25.0
        assert body["correlation_multiplier"] == 1.10
    finally:
        get_settings.cache_clear()


def test_decide_endpoint_returns_decisions(monkeypatch):
    c = _client_with_fake_kline(monkeypatch)
    try:
        res = c.post(
            "/synthesis/decide",
            json={
                "symbols": ["X.US"],
                "signals": [
                    {"source": "a", "symbol": "X.US", "signal": "bullish", "confidence": 80, "reasoning": ""},
                    {"source": "b", "symbol": "X.US", "signal": "bullish", "confidence": 80, "reasoning": ""},
                    {"source": "c", "symbol": "X.US", "signal": "bullish", "confidence": 80, "reasoning": ""},
                ],
                "portfolio": {"cash": 100_000, "total_value": 100_000, "positions": {}},
            },
        )
        assert res.status_code == 200
        decisions = res.json()["decisions"]
        assert len(decisions) == 1
        assert decisions[0]["action"] == "buy"
        assert decisions[0]["quantity"] > 0
    finally:
        get_settings.cache_clear()


def test_fallback_bullish_but_no_cash_holds():
    signals = [
        Signal(source="a", symbol="X.US", signal="bullish", confidence=90, reasoning=""),
        Signal(source="b", symbol="X.US", signal="bullish", confidence=90, reasoning=""),
    ]
    portfolio = PortfolioSnapshot(cash=0.0, total_value=100_000, positions={})
    res = decide_from_prices(["X.US"], signals, portfolio, {"X.US": _flat_closes(100.0)})
    d = res.decisions[0]
    assert d.action == "hold"
