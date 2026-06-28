from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput

D = Decimal


def test_valuation_endpoint_returns_result(monkeypatch):
    async def fake_fetch(symbol: str) -> ValuationInput:
        return ValuationInput(
            symbol=symbol,
            current_price=D("100"),
            fcf_base=D("100"),
            net_debt=D("0"),
            shares_outstanding=D("10"),
            beta=D("1.2"),
            history=[
                HistoryPeriod(period="2024", fcf=D("100")),
                HistoryPeriod(period="2021", fcf=D("80")),
            ],
            metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")),
        )

    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", fake_fetch)

    client = TestClient(create_app())
    r = client.get("/valuation", params={"symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "AAPL"
    assert body["data_quality"] in {"full", "multiples_only"}


def test_valuation_endpoint_degrades_on_fetch_error(monkeypatch):
    async def boom(symbol: str) -> ValuationInput:
        raise RuntimeError("yahoo down")

    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", boom)

    client = TestClient(create_app())
    r = client.get("/valuation", params={"symbol": "AAPL"})
    assert r.status_code == 200
    assert r.json()["data_quality"] == "unavailable"
