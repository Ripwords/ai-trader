"""Router-level tests for trade endpoints using FakeTradeAdapter."""
from datetime import datetime

from fastapi.testclient import TestClient

from app.schemas.quote import Snapshot
from app.schemas.trade import Account, Fill, Order, PlaceOrderResult, Portfolio, Position
from app.settings import get_settings


class FakeTradeAdapter:
    def __init__(self):
        # Extra per-env orders appended by tests (e.g. today's REAL orders
        # for the live-notional cap). The base ord-1 row is always present.
        self.extra_real_orders: list[Order] = []
        self.placed: list[dict] = []
        self.modified: list[dict] = []
        self.cancelled: list[dict] = []
        self.snapshot_last_price = 50.0

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
        base = [
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
        if trd_env == "REAL":
            return base + self.extra_real_orders
        return base

    def get_snapshot(self, code):
        return Snapshot(
            code=code,
            name=None,
            last_price=self.snapshot_last_price,
            open_price=self.snapshot_last_price,
            high_price=self.snapshot_last_price,
            low_price=self.snapshot_last_price,
            prev_close_price=self.snapshot_last_price,
            change_rate=0.0,
            volume=1,
            turnover=1.0,
            update_time=datetime(2026, 5, 8, 9, 30),
        )

    def place_order(self, *, code, side, qty, price=None, order_type="NORMAL",
                    trd_env="SIMULATE", acc_id=None, trigger_price=None):
        self.placed.append({
            "code": code, "side": side, "qty": qty, "price": price,
            "order_type": order_type, "trd_env": trd_env, "acc_id": acc_id,
            "trigger_price": trigger_price,
        })
        return PlaceOrderResult(
            order_id="ord-new",
            code=code,
            side=side,
            qty=qty,
            price=price or 0.0,
            status="SUBMITTED",
            trd_env=trd_env,
            acc_id=acc_id or "12345",
        )

    def modify_order(self, *, order_id, acc_id, price=None, qty=None,
                     trd_env="SIMULATE", trigger_price=None):
        self.modified.append({
            "order_id": order_id, "trd_env": trd_env,
            "price": price, "qty": qty, "trigger_price": trigger_price,
        })
        return {"order_id": order_id, "status": "MODIFIED"}

    def cancel_order(self, *, order_id, acc_id, trd_env="SIMULATE"):
        self.cancelled.append({"order_id": order_id, "trd_env": trd_env})
        return {"order_id": order_id, "status": "CANCELLED"}

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


# --- stop / stop-limit threading -------------------------------------------


def test_place_stop_order_threads_trigger_price(
    client_with_bearer_and_fake_trade, fake_trade_adapter
):
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "SELL", "qty": 10,
        "order_type": "STOP", "trigger_price": 95.0,
        "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    placed = fake_trade_adapter.placed[0]
    assert placed["order_type"] == "STOP"
    assert placed["trigger_price"] == 95.0


def test_place_stop_limit_order_threads_both_prices(
    client_with_bearer_and_fake_trade, fake_trade_adapter
):
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "SELL", "qty": 10, "price": 94.5,
        "order_type": "STOP_LIMIT", "trigger_price": 95.0,
        "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    placed = fake_trade_adapter.placed[0]
    assert placed["order_type"] == "STOP_LIMIT"
    assert placed["price"] == 94.5
    assert placed["trigger_price"] == 95.0


def test_modify_order_threads_trigger_price(
    client_with_bearer_and_fake_trade, fake_trade_adapter
):
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345",
        "trigger_price": 96.0, "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    assert fake_trade_adapter.modified[0]["trigger_price"] == 96.0


# --- live-order gating -----------------------------------------------------


def _enable_live(monkeypatch, cap: float | None = None) -> None:
    monkeypatch.setenv("ALLOW_LIVE_TRADING", "true")
    if cap is not None:
        monkeypatch.setenv("MAX_DAILY_LIVE_NOTIONAL_USD", str(cap))
    get_settings.cache_clear()


def test_real_place_blocked_by_default(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 403
    assert "live trading" in res.json()["detail"].lower()
    assert fake_trade_adapter.placed == []


def test_real_modify_blocked_by_default(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "price": 99.0, "trd_env": "REAL",
    })
    assert res.status_code == 403
    assert fake_trade_adapter.modified == []


def test_real_cancel_blocked_by_default(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/cancel", json={
        "order_id": "ord-1", "acc_id": "12345", "trd_env": "REAL",
    })
    assert res.status_code == 403
    assert fake_trade_adapter.cancelled == []


def test_simulate_place_unaffected_by_live_gate(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    assert len(fake_trade_adapter.placed) == 1
    assert fake_trade_adapter.placed[0]["trd_env"] == "SIMULATE"


def test_real_place_allowed_with_flag_under_cap(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 200
    assert fake_trade_adapter.placed[0]["trd_env"] == "REAL"


def test_real_modify_and_cancel_allowed_with_flag(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch)
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "price": 99.0, "trd_env": "REAL",
    })
    assert res.status_code == 200
    res = client_with_bearer_and_fake_trade.post("/trade/order/cancel", json={
        "order_id": "ord-1", "acc_id": "12345", "trd_env": "REAL",
    })
    assert res.status_code == 200


def test_real_place_rejected_when_daily_notional_cap_exceeded(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # Today's REAL orders already total 10 * 100 = $1000 (base ord-1);
    # default cap is $1000, so any additional live order must be rejected.
    _enable_live(monkeypatch)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409
    assert "notional" in res.json()["detail"].lower()
    assert fake_trade_adapter.placed == []


def test_real_market_order_notional_estimated_from_snapshot(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # Existing REAL notional $1000; cap $1500; snapshot last = $50.
    # MARKET 20 shares => $1000 estimated => $2000 total => rejected.
    _enable_live(monkeypatch, cap=1500)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 20, "order_type": "MARKET",
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409
    # MARKET 5 shares => $250 => $1250 total => allowed.
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 5, "order_type": "MARKET",
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 200


def test_cancelled_and_failed_real_orders_do_not_count_toward_cap(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=1200)
    fake_trade_adapter.extra_real_orders = [
        Order(order_id="ord-dead-1", code="US.NVDA", side="BUY", qty=100,
              price=100.0, status="CANCELLED_ALL",
              created_at=datetime(2026, 5, 8, 9, 30)),
        Order(order_id="ord-dead-2", code="US.NVDA", side="BUY", qty=100,
              price=100.0, status="FAILED",
              created_at=datetime(2026, 5, 8, 9, 30)),
    ]
    # Live notional that counts: only ord-1's $1000. $100 more fits in $1200.
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 200


def test_real_modify_is_checked_against_the_daily_cap(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    """Growing an existing REAL order must obey the same cap as placing one.
    ord-1 is 10 x $100 = $1000 today; cap $1200. Modifying it to 20 shares
    would make it $2000 (its old $1000 is swapped out, not added)."""
    _enable_live(monkeypatch, cap=1200)
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "qty": 20, "trd_env": "REAL",
    })
    assert res.status_code == 409
    assert "notional" in res.json()["detail"].lower()
    assert fake_trade_adapter.modified == []
    # Shrinking it to 11 shares ($1100) fits.
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "qty": 11, "trd_env": "REAL",
    })
    assert res.status_code == 200
    assert fake_trade_adapter.modified[0]["qty"] == 11


def test_real_modify_of_unknown_order_fails_closed(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-missing", "acc_id": "12345", "qty": 1, "trd_env": "REAL",
    })
    assert res.status_code == 409
    assert fake_trade_adapter.modified == []


def test_open_market_orders_reported_at_price_zero_count_at_snapshot_price(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    """moomoo echoes MARKET orders back with price 0, so summing qty * price
    let an unlimited number of REAL market orders through the cap."""
    _enable_live(monkeypatch, cap=1500)
    fake_trade_adapter.extra_real_orders = [
        Order(order_id="ord-mkt", code="US.NVDA", side="BUY", qty=10,
              price=0.0, status="SUBMITTED",
              created_at=datetime(2026, 5, 8, 9, 30)),
    ]
    # Counted: ord-1 $1000 + ord-mkt 10 x snapshot $50 = $1500. Nothing fits.
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 1.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409
    assert fake_trade_adapter.placed == []


def test_partially_cancelled_real_orders_still_count_toward_cap(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=1500)
    fake_trade_adapter.extra_real_orders = [
        Order(order_id="ord-part", code="US.NVDA", side="BUY", qty=5,
              price=100.0, status="CANCELLED_PART",
              created_at=datetime(2026, 5, 8, 9, 30)),
    ]
    # ord-1 $1000 + ord-part $500 = $1500 already at the cap.
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 1.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409


def test_real_place_requires_acc_id(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0,
        "trd_env": "REAL",
    })
    assert res.status_code == 422
    assert fake_trade_adapter.placed == []
