"""Adapter-level tests for OpendAdapter trade methods using FakeTradeCtx."""
import sys
import types

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
        self.place_calls: list[dict] = []
        self.modify_calls: list[dict] = []
        self.accinfo_calls: list[dict] = []

    def get_acc_list(self):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._acc_list)

    def position_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._positions)

    def accinfo_query(self, acc_id, trd_env, refresh_cache=False, currency=None):
        if self._fail:
            return -1, "boom"
        self.accinfo_calls.append({"acc_id": acc_id, "trd_env": trd_env, "currency": currency})
        rows = [dict(r) for r in self._accinfo]
        # Mirror OpenD: the account scalars come back converted into whatever
        # reporting currency the caller requested, and `currency` echoes it.
        if currency is not None:
            for r in rows:
                r["currency"] = currency
        return 0, pd.DataFrame(rows)

    def order_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._orders)

    def deal_list_query(self, acc_id, trd_env, refresh_cache=False):
        if self._fail:
            return -1, "boom"
        return 0, pd.DataFrame(self._fills)

    def place_order(self, **kwargs):
        if self._fail:
            return -1, "boom"
        self.place_calls.append(kwargs)
        return 0, pd.DataFrame([
            {
                "order_id": "ord-777",
                "code": kwargs["code"],
                "qty": kwargs["qty"],
                "price": kwargs["price"],
                "order_status": "SUBMITTED",
                "acc_id": kwargs["acc_id"],
            }
        ])

    def modify_order(self, **kwargs):
        if self._fail:
            return -1, "boom"
        self.modify_calls.append(kwargs)
        return 0, pd.DataFrame([{"order_id": kwargs["order_id"]}])

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
    assert acc.acc_id == "12345"
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
                "pl_ratio_avg_cost": 10.0,
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
    assert pos.pl_ratio == pytest.approx(0.10)  # SDK returned 10.0 (percentage) → normalized to 0.10


def test_get_portfolio_requests_configured_reporting_currency():
    """moomoo's accinfo_query defaults to currency='HKD'. Left unpassed it
    converts every account scalar into HKD and stamps currency='HKD',
    regardless of what the user actually reports in. The adapter must pass
    its configured reporting currency explicitly."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[],
        accinfo_payload=[{"cash": 1000.0, "market_val": 0.0, "total_assets": 1000.0}],
    ))
    adapter = OpendAdapter(
        host="ignored", port=0, report_currency="MYR", _trade_ctx_factory=lambda: _ctx
    )
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="REAL")
    assert _ctx.accinfo_calls[0]["currency"] == "MYR"
    assert portfolio.currency == "MYR"
    assert portfolio.reporting_currency_source == "requested"


def test_get_portfolio_currency_override_for_one_read():
    """The algo scheduler sizes orders in the symbol's own currency, so it
    asks for the totals in that currency instead of the display default."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[],
        accinfo_payload=[{"cash": 1000.0, "market_val": 0.0, "total_assets": 1000.0}],
    ))
    adapter = OpendAdapter(
        host="ignored", port=0, report_currency="MYR", _trade_ctx_factory=lambda: _ctx
    )
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="SIMULATE", currency="usd")
    assert _ctx.accinfo_calls[0]["currency"] == "USD"
    assert portfolio.currency == "USD"


def test_get_portfolio_defaults_reporting_currency_to_myr():
    """The default must not be the SDK's HKD."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[],
        accinfo_payload=[{"cash": 1000.0, "market_val": 0.0, "total_assets": 1000.0}],
    ))
    adapter = OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: _ctx)
    adapter.get_portfolio(acc_id=12345, trd_env="REAL")
    assert _ctx.accinfo_calls[0]["currency"] == "MYR"


def test_get_portfolio_rejects_unsupported_reporting_currency():
    """A typo'd config must fail loudly, not silently fall back to HKD."""
    with pytest.raises(ValueError, match="MYRR"):
        OpendAdapter(host="ignored", port=0, report_currency="MYRR")


def test_get_portfolio_preserves_currency():
    """moomoo returns a per-position `currency` column and a per-account
    settlement `currency`; both must survive into the typed schema so
    downstream consumers don't assume USD."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[
            {
                "code": "HK.00700",
                "qty": 100,
                "average_cost": 300.0,
                "nominal_price": 320.0,
                "market_val": 32000.0,
                "unrealized_pl": 2000.0,
                "pl_ratio_avg_cost": 6.67,
                "currency": "HKD",
            }
        ],
        accinfo_payload=[
            {
                "cash": 5000.0,
                "market_val": 32000.0,
                "total_assets": 37000.0,
                "currency": "HKD",
            }
        ],
    ))
    adapter = OpendAdapter(
        host="ignored", port=0, report_currency="HKD", _trade_ctx_factory=lambda: _ctx
    )
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="REAL")
    assert portfolio.currency == "HKD"
    # Per-position settlement currency is native and must NOT be rewritten by
    # the account-level reporting currency.
    assert portfolio.positions[0].currency == "HKD"


def test_get_portfolio_reports_native_cash_not_base_currency():
    """The scalar `cash`/`currency` from accinfo is the REPORTING-currency
    aggregate — every currency's cash converted into the currency we asked for.
    The native holdings live in the per-currency *_cash columns. A USD-only
    account must report USD cash, never a phantom balance in the reporting
    currency. Mirrors the real moomoo accinfo shape (native us_cash)."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[],
        accinfo_payload=[
            {
                "cash": 12806.63,        # HKD base-currency equivalent
                "market_val": 116228.86,
                "total_assets": 129035.49,
                "currency": "HKD",       # account home/reporting currency
                "us_cash": 1634.12,      # native USD cash (the truth)
                "hk_cash": 0.0,
                "my_cash": 0.0,
                "jp_cash": "N/A",        # unset markets come back as 'N/A'
                "au_cash": "N/A",
            }
        ],
    ))
    adapter = OpendAdapter(
        host="ignored", port=0, report_currency="HKD", _trade_ctx_factory=lambda: _ctx
    )
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="REAL")
    # Native holdings: only USD, no phantom HKD/MYR.
    assert portfolio.cash_by_currency == {"USD": 1634.12}
    # Reporting-currency scalar is preserved but labelled as the unit we asked for.
    assert portfolio.currency == "HKD"
    assert portfolio.cash == 12806.63


def test_get_portfolio_currency_falls_back_to_requested_when_column_absent():
    """Paper accounts / older SDKs may omit the currency column. Since we
    explicitly requested a reporting currency, the correct fallback is that
    currency — not None, and never a hardcoded HKD."""
    _set_ctx(FakeTradeCtx(
        positions_payload=[
            {"code": "US.NVDA", "qty": 1, "average_cost": 1.0, "nominal_price": 1.0,
             "market_val": 1.0, "unrealized_pl": 0.0, "pl_ratio_avg_cost": 0.0},
        ],
        accinfo_payload=[{"cash": 1.0, "market_val": 1.0, "total_assets": 2.0}],
    ))
    adapter = OpendAdapter(
        host="ignored", port=0, report_currency="MYR", _trade_ctx_factory=lambda: _ctx
    )
    portfolio = adapter.get_portfolio(acc_id=12345, trd_env="SIMULATE")
    assert portfolio.currency == "MYR"
    # Per-position settlement currency stays None when the broker omits it —
    # that one really is an unknown broker fact, not something we supply.
    assert portfolio.positions[0].currency is None


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


# --- place / modify / cancel RPC mapping ----------------------------------


def _adapter_with(ctx: FakeTradeCtx) -> OpendAdapter:
    return OpendAdapter(host="ignored", port=0, _trade_ctx_factory=lambda: ctx)


def test_place_limit_order_maps_fields():
    ctx = FakeTradeCtx()
    result = _adapter_with(ctx).place_order(
        code="US.NVDA", side="BUY", qty=10, price=100.0,
        order_type="NORMAL", trd_env="SIMULATE", acc_id="12345",
    )
    assert len(ctx.place_calls) == 1
    call = ctx.place_calls[0]
    assert call["code"] == "US.NVDA"
    assert str(call["trd_side"]) == "BUY"
    assert str(call["order_type"]) == "NORMAL"
    assert call["price"] == 100.0
    assert call["qty"] == 10
    assert call["aux_price"] is None
    assert result.order_id == "ord-777"
    assert result.side == "BUY"


def test_place_real_order_without_acc_id_is_refused():
    """The acc_id fallback resolves a SIMULATE account; submitting that id
    under REAL must never happen, however the adapter is called."""
    ctx = FakeTradeCtx()
    with pytest.raises(OpendError, match="acc_id is required for REAL"):
        _adapter_with(ctx).place_order(
            code="US.NVDA", side="BUY", qty=1, price=100.0,
            order_type="NORMAL", trd_env="REAL", acc_id=None,
        )
    assert ctx.place_calls == []


def test_place_market_order_sends_zero_price():
    ctx = FakeTradeCtx()
    _adapter_with(ctx).place_order(
        code="US.NVDA", side="SELL", qty=5, price=None,
        order_type="MARKET", trd_env="SIMULATE", acc_id="12345",
    )
    call = ctx.place_calls[0]
    assert str(call["order_type"]) == "MARKET"
    assert call["price"] == 0
    assert call["aux_price"] is None


def test_place_stop_order_maps_trigger_to_aux_price():
    ctx = FakeTradeCtx()
    _adapter_with(ctx).place_order(
        code="US.NVDA", side="SELL", qty=10, price=None,
        order_type="STOP", trigger_price=95.0,
        trd_env="SIMULATE", acc_id="12345",
    )
    call = ctx.place_calls[0]
    assert str(call["order_type"]) == "STOP"
    assert call["aux_price"] == 95.0
    assert call["price"] == 0  # STOP has no limit price


def test_place_stop_order_requires_trigger_price():
    ctx = FakeTradeCtx()
    with pytest.raises(OpendError, match="trigger_price"):
        _adapter_with(ctx).place_order(
            code="US.NVDA", side="SELL", qty=10,
            order_type="STOP", trd_env="SIMULATE", acc_id="12345",
        )
    assert ctx.place_calls == []


def test_place_stop_limit_order_maps_price_and_trigger():
    ctx = FakeTradeCtx()
    _adapter_with(ctx).place_order(
        code="US.NVDA", side="SELL", qty=10, price=94.5,
        order_type="STOP_LIMIT", trigger_price=95.0,
        trd_env="SIMULATE", acc_id="12345",
    )
    call = ctx.place_calls[0]
    assert str(call["order_type"]) == "STOP_LIMIT"
    assert call["price"] == 94.5
    assert call["aux_price"] == 95.0


def test_place_stop_limit_requires_both_prices():
    ctx = FakeTradeCtx()
    with pytest.raises(OpendError, match="trigger_price"):
        _adapter_with(ctx).place_order(
            code="US.NVDA", side="SELL", qty=10, price=94.5,
            order_type="STOP_LIMIT", trd_env="SIMULATE", acc_id="12345",
        )
    with pytest.raises(OpendError, match="price"):
        _adapter_with(ctx).place_order(
            code="US.NVDA", side="SELL", qty=10,
            order_type="STOP_LIMIT", trigger_price=95.0,
            trd_env="SIMULATE", acc_id="12345",
        )
    assert ctx.place_calls == []


def test_modify_order_maps_fields_and_aux_price():
    ctx = FakeTradeCtx()
    result = _adapter_with(ctx).modify_order(
        order_id="ord-777", acc_id="12345", price=101.0, qty=8,
        trigger_price=96.0, trd_env="SIMULATE",
    )
    assert len(ctx.modify_calls) == 1
    call = ctx.modify_calls[0]
    assert str(call["modify_order_op"]) == "NORMAL"
    assert call["order_id"] == "ord-777"
    assert call["price"] == 101.0
    assert call["qty"] == 8
    assert call["aux_price"] == 96.0
    assert result == {"order_id": "ord-777", "status": "MODIFIED"}


def test_modify_order_accepts_trigger_only():
    """Moving just the stop trigger is a valid modify."""
    ctx = FakeTradeCtx()
    _adapter_with(ctx).modify_order(
        order_id="ord-777", acc_id="12345", trigger_price=97.0,
        trd_env="SIMULATE",
    )
    assert ctx.modify_calls[0]["aux_price"] == 97.0


def test_modify_order_requires_some_change():
    ctx = FakeTradeCtx()
    with pytest.raises(OpendError, match="at least one"):
        _adapter_with(ctx).modify_order(
            order_id="ord-777", acc_id="12345", trd_env="SIMULATE",
        )
    assert ctx.modify_calls == []


def test_cancel_order_maps_cancel_op():
    ctx = FakeTradeCtx()
    result = _adapter_with(ctx).cancel_order(
        order_id="ord-777", acc_id="12345", trd_env="SIMULATE",
    )
    call = ctx.modify_calls[0]
    assert str(call["modify_order_op"]) == "CANCEL"
    assert call["order_id"] == "ord-777"
    assert result == {"order_id": "ord-777", "status": "CANCELLED"}


def test_default_factories_encrypt_when_key_path_set(monkeypatch, tmp_path):
    """OpenD enforces encryption on every non-loopback connection once it's
    started with -rsa_pri_key_path — both trade AND quote. When the api is
    configured with a key, both factories must register it with the SDK and
    flip is_encrypt=True so the InitConnect handshake SHA matches what OpenD
    computes."""
    key_path = tmp_path / "futu_rsa.key"
    key_path.write_text("dummy-key-bytes")  # SDK isn't actually invoked here

    captured: dict = {}

    class FakeSysConfig:
        @classmethod
        def set_init_rsa_file(cls, path):
            captured["rsa_file"] = path

    class FakeOpenSecTradeContext:
        def __init__(self, **kwargs):
            captured["trade_kwargs"] = kwargs

    class FakeOpenQuoteContext:
        def __init__(self, **kwargs):
            captured["quote_kwargs"] = kwargs

    class FakeTrdMarket:
        NONE = "TRDMKT_NONE"

    class FakeSecurityFirm:
        NONE = "SF_NONE"

    fake_moomoo = types.ModuleType("moomoo")
    fake_moomoo.OpenSecTradeContext = FakeOpenSecTradeContext
    fake_moomoo.OpenQuoteContext = FakeOpenQuoteContext
    fake_moomoo.SecurityFirm = FakeSecurityFirm
    fake_moomoo.TrdMarket = FakeTrdMarket
    fake_moomoo.SysConfig = FakeSysConfig
    monkeypatch.setitem(sys.modules, "moomoo", fake_moomoo)

    adapter = OpendAdapter(host="host.docker.internal", port=11111, rsa_key_path=str(key_path))
    adapter._default_trade_ctx_factory()
    adapter._default_ctx_factory()

    assert captured["rsa_file"] == str(key_path)
    assert captured["trade_kwargs"]["is_encrypt"] is True
    assert captured["quote_kwargs"]["is_encrypt"] is True


def test_default_factories_skip_encryption_without_key(monkeypatch):
    """No key path configured → leave is_encrypt unset on both factories so
    the SDK falls back to the global SysConfig flag (off by default). Keeps
    the in-process / 127.0.0.1 dev path working without forcing key
    generation."""
    captured: dict = {}

    class FakeSysConfig:
        @classmethod
        def set_init_rsa_file(cls, path):
            captured["rsa_file"] = path

    class FakeOpenSecTradeContext:
        def __init__(self, **kwargs):
            captured["trade_kwargs"] = kwargs

    class FakeOpenQuoteContext:
        def __init__(self, **kwargs):
            captured["quote_kwargs"] = kwargs

    class FakeTrdMarket:
        NONE = "TRDMKT_NONE"

    class FakeSecurityFirm:
        NONE = "SF_NONE"

    fake_moomoo = types.ModuleType("moomoo")
    fake_moomoo.OpenSecTradeContext = FakeOpenSecTradeContext
    fake_moomoo.OpenQuoteContext = FakeOpenQuoteContext
    fake_moomoo.SecurityFirm = FakeSecurityFirm
    fake_moomoo.TrdMarket = FakeTrdMarket
    fake_moomoo.SysConfig = FakeSysConfig
    monkeypatch.setitem(sys.modules, "moomoo", fake_moomoo)

    adapter = OpendAdapter(host="127.0.0.1", port=11111)
    adapter._default_trade_ctx_factory()
    adapter._default_ctx_factory()

    assert "rsa_file" not in captured
    assert "is_encrypt" not in captured["trade_kwargs"]
    assert "is_encrypt" not in captured["quote_kwargs"]
