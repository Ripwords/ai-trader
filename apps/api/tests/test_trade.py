"""Router-level tests for trade endpoints using FakeTradeAdapter."""
from datetime import datetime


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
                    trd_env="SIMULATE", acc_id=None, trigger_price=None,
                    trail_type=None, trail_value=None, trail_spread=None,
                    time_in_force="DAY", session="RTH", remark=None):
        self.placed.append({
            "code": code, "side": side, "qty": qty, "price": price,
            "order_type": order_type, "trd_env": trd_env, "acc_id": acc_id,
            "trigger_price": trigger_price, "trail_type": trail_type,
            "trail_value": trail_value, "trail_spread": trail_spread,
            "time_in_force": time_in_force, "session": session, "remark": remark,
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
                     trd_env="SIMULATE", trigger_price=None,
                     trail_type=None, trail_value=None, trail_spread=None):
        self.modified.append({
            "order_id": order_id, "trd_env": trd_env,
            "price": price, "qty": qty, "trigger_price": trigger_price,
            "trail_type": trail_type, "trail_value": trail_value, "trail_spread": trail_spread,
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
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "SELL", "qty": 10,
        "order_type": "STOP", "trigger_price": 95.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 200
    placed = fake_trade_adapter.placed[0]
    assert placed["order_type"] == "STOP"
    assert placed["trigger_price"] == 95.0


def test_place_stop_limit_order_threads_both_prices(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "SELL", "qty": 10, "price": 94.5,
        "order_type": "STOP_LIMIT", "trigger_price": 95.0,
        "trd_env": "REAL", "acc_id": "12345",
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


def test_two_live_orders_at_once_cannot_both_pass_the_daily_cap(monkeypatch):
    """The cap is checked, then the order placed. Two requests side by side
    both read the same spent total unless the check and the placement are
    one step, so two $900 orders under a $1000 cap both went through."""
    import threading
    import time

    from app.routers import trade
    from app.schemas.trade import PlaceOrderRequest

    _enable_live(monkeypatch, cap=1000)

    class Slow(FakeTradeAdapter):
        def list_orders(self, *, acc_id, trd_env="SIMULATE"):
            time.sleep(0.05)
            return list(self.extra_real_orders)

        def place_order(self, **kwargs):
            time.sleep(0.2)
            result = super().place_order(**kwargs)
            self.extra_real_orders.append(Order(
                order_id=f"ord-{len(self.extra_real_orders)}", code=kwargs["code"], side=kwargs["side"],
                qty=kwargs["qty"], price=kwargs["price"], status="SUBMITTED", created_at=datetime(2026, 5, 8, 9, 30),
            ))
            return result

    fake = Slow()
    body = PlaceOrderRequest(code="US.X", side="BUY", qty=9, price=100.0, trd_env="REAL", acc_id="12345")
    outcomes: list[str] = []

    def go():
        try:
            trade.place_order(body, fake)
            outcomes.append("placed")
        except Exception as exc:  # noqa: BLE001 - the refusal is what we count
            outcomes.append(type(exc).__name__)

    threads = [threading.Thread(target=go) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(outcomes) == ["HTTPException", "placed"]
    assert len(fake.placed) == 1


def test_a_live_stop_order_counts_at_its_trigger_when_that_is_above_the_last_trade(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # Last trade $50 (fake snapshot); a BUY STOP triggers at $200 and fills
    # near there. 10 shares is $2000 at the trigger, $500 at the last trade.
    _enable_live(monkeypatch, cap=2500)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 10, "order_type": "STOP",
        "trigger_price": 200.0, "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409
    assert fake_trade_adapter.placed == []


def test_an_open_live_stop_order_counts_at_its_trigger(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # moomoo reports an open STOP at price 0; it is worth 10 * $200 at its
    # trigger, so with ord-1's $1000 there is no room under a $2500 cap.
    _enable_live(monkeypatch, cap=2500)
    fake_trade_adapter.extra_real_orders = [
        Order(order_id="ord-stop", code="US.NVDA", side="BUY", qty=10, price=0.0, trigger_price=200.0,
              status="SUBMITTED", created_at=datetime(2026, 5, 8, 9, 30)),
    ]
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 5, "price": 100.0,
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 409


# --- order settings, rules and the cap for the newer order types ----------


def test_place_threads_tif_session_trail_and_remark(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "SELL", "qty": 10, "order_type": "TRAILING_STOP_LIMIT",
        "trail_type": "RATIO", "trail_value": 5.0, "trail_spread": 0.1,
        "time_in_force": "GTC", "session": "ETH", "remark": "q:abc",
        "trd_env": "REAL", "acc_id": "12345",
    })
    assert res.status_code == 200, res.text
    placed = fake_trade_adapter.placed[0]
    assert placed["order_type"] == "TRAILING_STOP_LIMIT"
    assert placed["trail_type"] == "RATIO"
    assert placed["trail_value"] == 5.0
    assert placed["trail_spread"] == 0.1
    assert placed["time_in_force"] == "GTC"
    assert placed["session"] == "ETH"
    assert placed["remark"] == "q:abc"


def test_place_defaults_to_day_and_regular_hours(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "price": 100.0, "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    assert fake_trade_adapter.placed[0]["time_in_force"] == "DAY"
    assert fake_trade_adapter.placed[0]["session"] == "RTH"


def test_modify_threads_trail_fields(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "trail_type": "AMOUNT", "trail_value": 2.0,
        "trail_spread": 0.05, "trd_env": "SIMULATE",
    })
    assert res.status_code == 200
    m = fake_trade_adapter.modified[0]
    assert (m["trail_type"], m["trail_value"], m["trail_spread"]) == ("AMOUNT", 2.0, 0.05)


def _place_status(client, **body):
    return client.post("/trade/order/place", json={
        "code": "US.NVDA", "side": "BUY", "qty": 1, "acc_id": "12345", **body,
    })


def test_order_rule_violations_are_422_and_place_nothing(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=100_000)
    c = client_with_bearer_and_fake_trade
    bad = [
        {"order_type": "STOP", "trd_env": "SIMULATE", "trigger_price": 95.0},
        {"order_type": "NORMAL", "price": 100.0, "trd_env": "SIMULATE", "time_in_force": "GTC"},
        {"order_type": "NORMAL", "price": 100.0, "trd_env": "SIMULATE", "session": "OVERNIGHT"},
        {"order_type": "MARKET", "trd_env": "REAL", "session": "ETH"},
        {"order_type": "STOP_LIMIT", "price": 100.0, "trigger_price": 99.0, "trd_env": "REAL", "session": "OVERNIGHT"},
        {"order_type": "MARKET_IF_TOUCHED", "trd_env": "REAL"},
        {"order_type": "TRAILING_STOP", "trd_env": "REAL", "trail_value": 5.0},
        {"order_type": "TRAILING_STOP_LIMIT", "trd_env": "REAL", "trail_type": "RATIO", "trail_value": 5.0},
        {"order_type": "NORMAL", "price": 100.0, "trd_env": "REAL", "remark": "x" * 65},
        {"order_type": "NORMAL", "price": 100.0, "trd_env": "REAL", "time_in_force": "GTD"},
        {"order_type": "NORMAL", "price": 100.0, "trd_env": "REAL", "session": "PRE"},
    ]
    for body in bad:
        res = _place_status(c, **body)
        assert res.status_code == 422, (body, res.text)
    assert fake_trade_adapter.placed == []


def test_modify_needing_a_trail_type_is_422(client_with_bearer_and_fake_trade, fake_trade_adapter):
    res = client_with_bearer_and_fake_trade.post("/trade/order/modify", json={
        "order_id": "ord-1", "acc_id": "12345", "trail_value": 2.0, "trd_env": "SIMULATE",
    })
    assert res.status_code == 422
    assert fake_trade_adapter.modified == []


def test_a_stray_price_on_a_market_order_does_not_shrink_its_notional(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # ord-1 is $1000; cap $1500; last $50. 20 shares at market is $1000,
    # not the $20 a stray "price": 1 would make it.
    _enable_live(monkeypatch, cap=1500)
    res = _place_status(client_with_bearer_and_fake_trade, order_type="MARKET", qty=20, price=1.0, trd_env="REAL")
    assert res.status_code == 409
    assert fake_trade_adapter.placed == []


def test_a_live_market_if_touched_order_counts_at_its_trigger(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # Last $50; a BUY MIT at $200 is 10 x $200 = $2000, over $2500 with ord-1.
    _enable_live(monkeypatch, cap=2500)
    res = _place_status(
        client_with_bearer_and_fake_trade, order_type="MARKET_IF_TOUCHED", qty=10,
        trigger_price=200.0, trd_env="REAL",
    )
    assert res.status_code == 409


def test_a_live_limit_if_touched_order_counts_at_the_higher_of_trigger_and_limit(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=2500)
    res = _place_status(
        client_with_bearer_and_fake_trade, order_type="LIMIT_IF_TOUCHED", qty=10,
        price=10.0, trigger_price=200.0, trd_env="REAL",
    )
    assert res.status_code == 409
    res = _place_status(
        client_with_bearer_and_fake_trade, order_type="LIMIT_IF_TOUCHED", qty=10,
        price=100.0, trigger_price=10.0, trd_env="REAL",
    )
    assert res.status_code == 200


def test_a_live_trailing_stop_counts_at_the_last_price_plus_its_trail(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    # Last $50. A 100% ratio trail can fill near $100: 10 x $100 = $1000,
    # which with ord-1's $1000 is over a $1900 cap. 10 x $50 alone would fit.
    _enable_live(monkeypatch, cap=1900)
    res = _place_status(
        client_with_bearer_and_fake_trade, order_type="TRAILING_STOP", qty=10,
        trail_type="RATIO", trail_value=100.0, trd_env="REAL",
    )
    assert res.status_code == 409
    # An AMOUNT trail of $2 plus a $1 spread: 10 x $53 = $530 fits.
    res = _place_status(
        client_with_bearer_and_fake_trade, order_type="TRAILING_STOP_LIMIT", qty=10,
        trail_type="AMOUNT", trail_value=2.0, trail_spread=1.0, trd_env="REAL",
    )
    assert res.status_code == 200


def test_an_open_live_trailing_order_counts_toward_the_cap(
    monkeypatch, client_with_bearer_and_fake_trade, fake_trade_adapter
):
    _enable_live(monkeypatch, cap=1550)
    fake_trade_adapter.extra_real_orders = [
        Order(order_id="ord-trail", code="US.NVDA", side="SELL", qty=10, price=0.0,
              status="SUBMITTED", created_at=datetime(2026, 5, 8, 9, 30),
              order_type="TRAILING_STOP", trail_type="AMOUNT", trail_value=5.0),
    ]
    # ord-1 $1000 + ord-trail 10 x ($50 + $5) = $1550: no room left.
    res = _place_status(client_with_bearer_and_fake_trade, price=1.0, trd_env="REAL")
    assert res.status_code == 409


def test_orders_active_only_drops_finished_orders(client_with_bearer_and_fake_trade, fake_trade_adapter):
    fake_trade_adapter.extra_real_orders = [
        Order(order_id=f"ord-{s}", code="US.NVDA", side="BUY", qty=1, price=1.0, status=s,
              created_at=datetime(2026, 5, 8, 9, 30))
        for s in ("SUBMITTED", "FILLED_PART", "WAITING_SUBMIT", "CANCELLED_ALL", "CANCELLED_PART",
                  "FAILED", "SUBMIT_FAILED", "DELETED", "DISABLED", "TIMEOUT", "FILL_CANCELLED")
    ]
    res = client_with_bearer_and_fake_trade.get("/trade/orders", params={"acc_id": "12345", "active_only": True})
    assert res.status_code == 200
    # ord-1 is FILLED_ALL, so it goes too.
    assert sorted(o["order_id"] for o in res.json()) == ["ord-FILLED_PART", "ord-SUBMITTED", "ord-WAITING_SUBMIT"]
    res = client_with_bearer_and_fake_trade.get("/trade/orders", params={"acc_id": "12345"})
    assert len(res.json()) == 12
