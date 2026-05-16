from datetime import datetime

from fastapi.testclient import TestClient

from app.schemas.quote import Bar, KLineResponse, OrderBook, OrderBookLevel, Snapshot


class FakeAdapter:
    def get_kline(self, code, *, ktype, num):
        return KLineResponse(
            code=code,
            ktype=ktype,
            bars=[
                Bar(
                    time=datetime(2026, 5, 6),
                    open=100.0,
                    high=110.0,
                    low=95.0,
                    close=108.0,
                    volume=1000,
                    turnover=100_000.0,
                )
            ],
        )

    def get_snapshot(self, code):
        return Snapshot(
            code=code,
            name="Test",
            last_price=125.5,
            open_price=120.0,
            high_price=126.0,
            low_price=119.5,
            prev_close_price=121.0,
            change_rate=0.0372,
            volume=12_345_678,
            turnover=1_500_000_000.0,
            update_time=datetime(2026, 5, 7, 16, 0),
        )

    def get_order_book(self, code, *, num):
        return OrderBook(
            code=code,
            name="Test",
            bid_time="2026-05-07 16:00:00.000",
            ask_time="2026-05-07 16:00:00.000",
            bids=[OrderBookLevel(price=125.40, volume=300, order_count=2)],
            asks=[OrderBookLevel(price=125.50, volume=200, order_count=1)],
        )


def test_kline_endpoint_returns_bars(client_with_bearer_and_fake: TestClient):
    res = client_with_bearer_and_fake.get(
        "/quote/kline",
        params={"code": "US.NVDA", "ktype": "1d", "num": 1},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["code"] == "US.NVDA"
    assert len(body["bars"]) == 1
    assert body["bars"][0]["close"] == 108.0


def test_snapshot_endpoint_returns_quote(client_with_bearer_and_fake: TestClient):
    res = client_with_bearer_and_fake.get(
        "/quote/snapshot",
        params={"code": "US.NVDA"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["last_price"] == 125.5


def test_order_book_endpoint_returns_depth(client_with_bearer_and_fake: TestClient):
    res = client_with_bearer_and_fake.get(
        "/quote/order-book",
        params={"code": "US.NVDA", "num": 5},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["code"] == "US.NVDA"
    assert body["bids"][0]["price"] == 125.40
    assert body["asks"][0]["volume"] == 200


def test_quote_routes_require_bearer(client: TestClient):
    res = client.get("/quote/kline", params={"code": "US.NVDA", "ktype": "1d", "num": 1})
    assert res.status_code == 401
