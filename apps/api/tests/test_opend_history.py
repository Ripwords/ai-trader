"""Adapter-level tests for OpendAdapter historical order/fill queries.

Follows the FakeTradeCtx style of test_opend_trade.py: the fake records the
kwargs the adapter passes so we can assert the date range / filters reach
the SDK call (history_order_list_query / history_deal_list_query).
"""
import pandas as pd
import pytest

from app.schemas.trade import Fill, Order
from app.services.opend import OpendAdapter, OpendError


class FakeHistoryTradeCtx:
    def __init__(self, orders_payload=None, fills_payload=None, fail=False):
        self._orders = orders_payload or []
        self._fills = fills_payload or []
        self._fail = fail
        self.history_order_kwargs: dict | None = None
        self.history_deal_kwargs: dict | None = None

    def history_order_list_query(self, **kwargs):
        self.history_order_kwargs = kwargs
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._orders)

    def history_deal_list_query(self, **kwargs):
        self.history_deal_kwargs = kwargs
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._fills)

    def close(self):
        pass


def test_list_history_orders_returns_typed_and_forwards_range():
    ctx = FakeHistoryTradeCtx(orders_payload=[
        {
            "order_id": "ord-h1",
            "code": "US.NVDA",
            "trd_side": "BUY",
            "qty": 10,
            "price": 100.0,
            "order_status": "FILLED_ALL",
            "create_time": "2026-06-20 09:30:00",
        }
    ])
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)
    orders = adapter.list_history_orders(
        acc_id="12345", trd_env="SIMULATE", start="2026-06-18", end="2026-07-18"
    )
    assert len(orders) == 1
    o = orders[0]
    assert isinstance(o, Order)
    assert o.order_id == "ord-h1"
    assert o.side == "BUY"
    assert o.status == "FILLED_ALL"
    assert ctx.history_order_kwargs is not None
    assert ctx.history_order_kwargs["start"] == "2026-06-18"
    assert ctx.history_order_kwargs["end"] == "2026-07-18"
    assert ctx.history_order_kwargs["acc_id"] == 12345


def test_list_history_orders_forwards_code_filter_and_defaults_range_empty():
    ctx = FakeHistoryTradeCtx(orders_payload=[])
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)
    orders = adapter.list_history_orders(acc_id="12345", trd_env="REAL", code="US.NVDA")
    assert orders == []
    # No explicit range → SDK default ('' means the SDK's own window).
    assert ctx.history_order_kwargs["start"] == ""
    assert ctx.history_order_kwargs["end"] == ""
    assert ctx.history_order_kwargs["code"] == "US.NVDA"


def test_list_history_orders_raises_on_error():
    ctx = FakeHistoryTradeCtx(fail=True)
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)
    with pytest.raises(OpendError, match="history_order_list_query failed"):
        adapter.list_history_orders(acc_id="12345", trd_env="SIMULATE")


def test_list_history_fills_returns_typed_and_forwards_range():
    ctx = FakeHistoryTradeCtx(fills_payload=[
        {
            "deal_id": "fill-h1",
            "order_id": "ord-h1",
            "code": "US.NVDA",
            "trd_side": "SELL",
            "qty": 5,
            "price": 115.0,
            "create_time": "2026-06-21 10:00:00",
        }
    ])
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)
    fills = adapter.list_history_fills(
        acc_id="12345", trd_env="SIMULATE", start="2026-06-18", end="2026-07-18"
    )
    assert len(fills) == 1
    f = fills[0]
    assert isinstance(f, Fill)
    assert f.fill_id == "fill-h1"
    assert f.order_id == "ord-h1"
    assert f.side == "SELL"
    assert ctx.history_deal_kwargs["start"] == "2026-06-18"
    assert ctx.history_deal_kwargs["end"] == "2026-07-18"
    assert ctx.history_deal_kwargs["acc_id"] == 12345


def test_list_history_fills_raises_on_error():
    ctx = FakeHistoryTradeCtx(fail=True)
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)
    with pytest.raises(OpendError, match="history_deal_list_query failed"):
        adapter.list_history_fills(acc_id="12345", trd_env="SIMULATE")
