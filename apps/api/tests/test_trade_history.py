"""Router-level tests for the historical trade endpoints."""
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.deps import get_opend
from app.main import create_app
from app.schemas.trade import Fill, Order
from app.services.opend import OpendError
from app.settings import get_settings


class FakeHistoryAdapter:
    def __init__(self, fail=False):
        self.fail = fail
        self.orders_kwargs: dict | None = None
        self.fills_kwargs: dict | None = None

    def list_history_orders(self, *, acc_id, trd_env="SIMULATE", start=None, end=None, code=""):
        if self.fail:
            raise OpendError("history_order_list_query failed: boom")
        self.orders_kwargs = {
            "acc_id": acc_id, "trd_env": trd_env, "start": start, "end": end, "code": code,
        }
        return [
            Order(
                order_id="ord-h1",
                code="US.NVDA",
                side="BUY",
                qty=10,
                price=100.0,
                status="FILLED_ALL",
                created_at=datetime(2026, 6, 20, 9, 30),
            )
        ]

    def list_history_fills(self, *, acc_id, trd_env="SIMULATE", start=None, end=None, code=""):
        if self.fail:
            raise OpendError("history_deal_list_query failed: boom")
        self.fills_kwargs = {
            "acc_id": acc_id, "trd_env": trd_env, "start": start, "end": end, "code": code,
        }
        return [
            Fill(
                fill_id="fill-h1",
                order_id="ord-h1",
                code="US.NVDA",
                side="SELL",
                qty=5,
                price=115.0,
                fill_at=datetime(2026, 6, 21, 10, 0),
            )
        ]


@pytest.fixture
def fake_history_adapter():
    return FakeHistoryAdapter()


@pytest.fixture
def client_with_bearer_and_fake_history(monkeypatch, fake_history_adapter):
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: fake_history_adapter
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_orders_history_endpoint(client_with_bearer_and_fake_history, fake_history_adapter):
    res = client_with_bearer_and_fake_history.get(
        "/trade/orders/history",
        params={"acc_id": "12345", "start": "2026-06-18", "end": "2026-07-18"},
    )
    assert res.status_code == 200
    assert res.json()[0]["order_id"] == "ord-h1"
    assert fake_history_adapter.orders_kwargs["start"] == "2026-06-18"
    assert fake_history_adapter.orders_kwargs["end"] == "2026-07-18"


def test_orders_history_defaults_to_last_30_days(client_with_bearer_and_fake_history, fake_history_adapter):
    res = client_with_bearer_and_fake_history.get(
        "/trade/orders/history", params={"acc_id": "12345"}
    )
    assert res.status_code == 200
    today = date.today()
    assert fake_history_adapter.orders_kwargs["end"] == today.isoformat()
    assert fake_history_adapter.orders_kwargs["start"] == (today - timedelta(days=30)).isoformat()


def test_fills_history_endpoint(client_with_bearer_and_fake_history, fake_history_adapter):
    res = client_with_bearer_and_fake_history.get(
        "/trade/fills/history",
        params={"acc_id": "12345", "trd_env": "SIMULATE", "code": "US.NVDA"},
    )
    assert res.status_code == 200
    assert res.json()[0]["fill_id"] == "fill-h1"
    assert fake_history_adapter.fills_kwargs["trd_env"] == "SIMULATE"
    assert fake_history_adapter.fills_kwargs["code"] == "US.NVDA"


def test_fills_history_defaults_to_last_30_days(client_with_bearer_and_fake_history, fake_history_adapter):
    res = client_with_bearer_and_fake_history.get(
        "/trade/fills/history", params={"acc_id": "12345"}
    )
    assert res.status_code == 200
    today = date.today()
    assert fake_history_adapter.fills_kwargs["end"] == today.isoformat()
    assert fake_history_adapter.fills_kwargs["start"] == (today - timedelta(days=30)).isoformat()


def test_history_endpoints_map_opend_errors(monkeypatch):
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: FakeHistoryAdapter(fail=True)
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    try:
        res = c.get("/trade/orders/history", params={"acc_id": "12345"})
        assert res.status_code == 502
        res = c.get("/trade/fills/history", params={"acc_id": "12345"})
        assert res.status_code == 502
    finally:
        app.dependency_overrides.clear()
        get_settings.cache_clear()


def test_history_routes_require_bearer(client):
    res = client.get("/trade/orders/history", params={"acc_id": "12345"})
    assert res.status_code == 401
    res = client.get("/trade/fills/history", params={"acc_id": "12345"})
    assert res.status_code == 401
