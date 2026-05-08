"""Router-level tests for trade endpoints using FakeTradeAdapter."""
from datetime import datetime

from fastapi.testclient import TestClient

from app.schemas.trade import Account, Fill, Order, Portfolio, Position


class FakeTradeAdapter:
    def list_accounts(self):
        return [Account(acc_id="12345", trd_env="SIMULATE", acc_type="CASH", trdmarket_auth=["US"], acc_role="OWNER")]

    def get_portfolio(self, *, acc_id, trd_env="SIMULATE"):
        return Portfolio(
            cash=10000.0,
            market_val=5000.0,
            total_assets=15000.0,
            positions=[
                Position(
                    code="US.NVDA",
                    qty=10,
                    cost_price=100.0,
                    current_price=110.0,
                    market_val=1100.0,
                    pl_val=100.0,
                    pl_ratio=0.10,
                )
            ],
        )

    def list_orders(self, *, acc_id, trd_env="SIMULATE"):
        return [
            Order(
                order_id="ord-1",
                code="US.NVDA",
                side="BUY",
                qty=10,
                price=100.0,
                status="FILLED_ALL",
                created_at=datetime(2026, 5, 8, 9, 30),
            )
        ]

    def list_fills(self, *, acc_id, trd_env="SIMULATE"):
        return [
            Fill(
                fill_id="f-1",
                order_id="ord-1",
                code="US.NVDA",
                side="BUY",
                qty=10,
                price=100.0,
                fill_at=datetime(2026, 5, 8, 9, 30),
            )
        ]


def test_accounts_endpoint(client_with_bearer_and_fake_trade):
    res = client_with_bearer_and_fake_trade.get("/trade/accounts")
    assert res.status_code == 200
    assert res.json()[0]["acc_id"] == "12345"


def test_portfolio_endpoint(client_with_bearer_and_fake_trade):
    res = client_with_bearer_and_fake_trade.get("/trade/portfolio", params={"acc_id": 12345})
    assert res.status_code == 200
    assert res.json()["cash"] == 10000.0
    assert res.json()["positions"][0]["code"] == "US.NVDA"


def test_orders_endpoint(client_with_bearer_and_fake_trade):
    res = client_with_bearer_and_fake_trade.get("/trade/orders", params={"acc_id": 12345})
    assert res.status_code == 200
    assert res.json()[0]["order_id"] == "ord-1"


def test_fills_endpoint(client_with_bearer_and_fake_trade):
    res = client_with_bearer_and_fake_trade.get("/trade/fills", params={"acc_id": 12345})
    assert res.status_code == 200
    assert res.json()[0]["fill_id"] == "f-1"


def test_trade_routes_require_bearer(client):
    res = client.get("/trade/accounts")
    assert res.status_code == 401
