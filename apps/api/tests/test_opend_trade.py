"""Adapter-level tests for OpendAdapter trade methods using FakeTradeCtx."""
import pandas as pd
import pytest

from app.schemas.trade import Account, Fill, Order, Portfolio, Position
from app.services.opend import OpendAdapter, OpendError


class FakeTradeCtx:
    def __init__(
        self,
        acc_list_payload=None,
        positions_payload=None,
        accinfo_payload=None,
        orders_payload=None,
        fills_payload=None,
        fail=False,
    ):
        self._acc_list = acc_list_payload or []
        self._positions = positions_payload or []
        self._accinfo = accinfo_payload or []
        self._orders = orders_payload or []
        self._fills = fills_payload or []
        self._fail = fail

    def get_acc_list(self):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._acc_list)

    def position_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._positions)

    def accinfo_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._accinfo)

    def order_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._orders)

    def deal_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._fills)

    def close(self):
        pass


# Module-level fake context — tests set this before each call
_ctx: FakeTradeCtx | None = None


def _set_ctx(ctx: FakeTradeCtx) -> None:
    global _ctx
    _ctx = ctx


def test_list_accounts_returns_typed():
    _set_ctx(FakeTradeCtx(acc_list_payload=[
        {
            "acc_id": 12345,
            "trd_env": "SIMULATE",
            "acc_type": "CASH",
            "card_num": "ABC123",
            "security_firm": "FUTUINC",
            "trdmarket_auth": ["US", "HK"],
            "acc_role": "MASTER",
        }
    ]))
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: _ctx)
    accounts = adapter.list_accounts()
    assert len(accounts) == 1
    acc = accounts[0]
    assert isinstance(acc, Account)
    assert acc.acc_id == 12345
    assert acc.trd_env == "SIMULATE"
    assert acc.acc_type == "CASH"


def test_get_portfolio_merges_positions_and_account():
    _set_ctx(FakeTradeCtx(
        positions_payload=[
            {
                "code": "US.NVDA",
                "qty": 10,
                "average_cost": 100.0,
                "nominal_price": 110.0,
                "market_val": 1100.0,
                "unrealized_pl": 100.0,
                "pl_ratio_avg_cost": 0.10,
            }
        ],
        accinfo_payload=[
            {
                "cash": 10000.0,
                "market_val": 1100.0,
                "total_assets": 11100.0,
            }
        ],
    ))
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: _ctx)
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="SIMULATE")
    assert isinstance(portfolio, Portfolio)
    assert portfolio.cash == 10000.0
    assert portfolio.total_assets == 11100.0
    assert len(portfolio.positions) == 1
    pos = portfolio.positions[0]
    assert isinstance(pos, Position)
    assert pos.code == "US.NVDA"
    assert pos.qty == 10
    assert pos.cost_price == 100.0
    assert pos.current_price == 110.0
    assert pos.pl_val == 100.0


def test_list_orders_returns_typed():
    _set_ctx(FakeTradeCtx(orders_payload=[
        {
            "order_id": "ord-001",
            "code": "US.NVDA",
            "trd_side": "BUY",
            "qty": 10,
            "price": 100.0,
            "order_status": "FILLED_ALL",
            "create_time": "2026-05-08 09:30:00",
        }
    ]))
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: _ctx)
    orders = adapter.list_orders(acc_id=12345, trd_env="SIMULATE")
    assert len(orders) == 1
    o = orders[0]
    assert isinstance(o, Order)
    assert o.order_id == "ord-001"
    assert o.code == "US.NVDA"
    assert o.side == "BUY"
    assert o.qty == 10
    assert o.status == "FILLED_ALL"


def test_list_fills_returns_typed():
    _set_ctx(FakeTradeCtx(fills_payload=[
        {
            "deal_id": "fill-001",
            "order_id": "ord-001",
            "code": "US.NVDA",
            "trd_side": "SELL",
            "qty": 5,
            "price": 115.0,
            "create_time": "2026-05-08 10:00:00",
        }
    ]))
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: _ctx)
    fills = adapter.list_fills(acc_id=12345, trd_env="SIMULATE")
    assert len(fills) == 1
    f = fills[0]
    assert isinstance(f, Fill)
    assert f.fill_id == "fill-001"
    assert f.order_id == "ord-001"
    assert f.side == "SELL"
    assert f.qty == 5
    assert f.price == 115.0
