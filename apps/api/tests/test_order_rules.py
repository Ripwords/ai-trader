"""The one place moomoo's order rules live, tested without an adapter."""
import pytest

from app.services.order_rules import OrderRuleError, check_modify_order, check_place_order


def _place(**overrides):
    args = {
        "code": "US.NVDA",
        "order_type": "NORMAL",
        "trd_env": "REAL",
        "price": 100.0,
        "trigger_price": None,
        "trail_type": None,
        "trail_value": None,
        "trail_spread": None,
        "time_in_force": "DAY",
        "session": "RTH",
        "remark": None,
    }
    args.update(overrides)
    return check_place_order(**args)


def test_a_plain_limit_order_passes_unchanged():
    assert _place() == {"price": 100.0, "trigger_price": None}


@pytest.mark.parametrize("order_type", ["NORMAL", "STOP_LIMIT", "LIMIT_IF_TOUCHED"])
def test_limit_types_need_a_price(order_type):
    with pytest.raises(OrderRuleError, match="price is required"):
        _place(order_type=order_type, price=None, trigger_price=95.0)


@pytest.mark.parametrize("order_type", ["STOP", "STOP_LIMIT", "MARKET_IF_TOUCHED", "LIMIT_IF_TOUCHED"])
def test_triggered_types_need_a_trigger_price(order_type):
    with pytest.raises(OrderRuleError, match="trigger_price is required"):
        _place(order_type=order_type, trigger_price=None)


@pytest.mark.parametrize("order_type", ["TRAILING_STOP", "TRAILING_STOP_LIMIT"])
def test_trailing_types_need_trail_type_and_value(order_type):
    with pytest.raises(OrderRuleError, match="trail_type"):
        _place(order_type=order_type, price=None, trail_value=5.0, trail_spread=0.1)
    with pytest.raises(OrderRuleError, match="trail_value"):
        _place(order_type=order_type, price=None, trail_type="RATIO", trail_spread=0.1)


def test_trailing_stop_limit_needs_a_spread():
    with pytest.raises(OrderRuleError, match="trail_spread"):
        _place(order_type="TRAILING_STOP_LIMIT", price=None, trail_type="RATIO", trail_value=5.0)


def test_a_trail_value_must_be_positive():
    with pytest.raises(OrderRuleError, match="trail_value"):
        _place(order_type="TRAILING_STOP", price=None, trail_type="AMOUNT", trail_value=0)


def test_trail_fields_are_refused_on_a_non_trailing_order():
    with pytest.raises(OrderRuleError, match="trail"):
        _place(trail_type="RATIO", trail_value=5.0)


def test_unused_price_and_trigger_are_dropped_so_the_cap_cannot_be_fooled():
    # A MARKET order "priced" at $1 would otherwise be valued at $1 a share.
    assert _place(order_type="MARKET", price=1.0, trigger_price=2.0) == {"price": None, "trigger_price": None}
    assert _place(order_type="STOP", price=1.0, trigger_price=95.0) == {"price": None, "trigger_price": 95.0}
    assert _place(order_type="NORMAL", price=100.0, trigger_price=95.0) == {"price": 100.0, "trigger_price": None}
    assert _place(
        order_type="TRAILING_STOP_LIMIT", price=9.0, trigger_price=9.0,
        trail_type="RATIO", trail_value=5.0, trail_spread=0.1,
    ) == {"price": None, "trigger_price": None}


@pytest.mark.parametrize("order_type", ["STOP", "STOP_LIMIT", "MARKET_IF_TOUCHED", "LIMIT_IF_TOUCHED"])
def test_paper_accounts_take_only_limit_and_market_orders(order_type):
    with pytest.raises(OrderRuleError, match="paper"):
        _place(trd_env="SIMULATE", order_type=order_type, trigger_price=95.0)


def test_paper_accounts_refuse_trailing_orders():
    with pytest.raises(OrderRuleError, match="paper"):
        _place(trd_env="SIMULATE", order_type="TRAILING_STOP", price=None, trail_type="RATIO", trail_value=5.0)


def test_paper_accounts_take_day_orders_only():
    with pytest.raises(OrderRuleError, match="DAY"):
        _place(trd_env="SIMULATE", time_in_force="GTC")


@pytest.mark.parametrize("session", ["OVERNIGHT", "ALL"])
def test_paper_accounts_have_no_overnight_session(session):
    with pytest.raises(OrderRuleError, match="paper"):
        _place(trd_env="SIMULATE", session=session)


def test_paper_accounts_take_extended_hours_limit_orders():
    _place(trd_env="SIMULATE", session="ETH")


@pytest.mark.parametrize("session", ["ETH", "OVERNIGHT", "ALL"])
def test_market_orders_run_in_regular_hours_only(session):
    with pytest.raises(OrderRuleError, match="MARKET"):
        _place(order_type="MARKET", price=None, session=session)


@pytest.mark.parametrize("session", ["OVERNIGHT", "ALL"])
@pytest.mark.parametrize("order_type", ["STOP", "STOP_LIMIT", "LIMIT_IF_TOUCHED"])
def test_overnight_sessions_take_limit_orders_only(session, order_type):
    with pytest.raises(OrderRuleError, match="limit"):
        _place(order_type=order_type, trigger_price=95.0, session=session)


@pytest.mark.parametrize("session", ["OVERNIGHT", "ALL"])
@pytest.mark.parametrize("tif", ["DAY", "GTC"])
def test_an_overnight_limit_order_is_allowed_day_or_gtc(session, tif):
    _place(session=session, time_in_force=tif)


def test_sessions_apply_to_us_stocks_only():
    with pytest.raises(OrderRuleError, match="US"):
        _place(code="HK.00700", session="ETH")
    _place(code="HK.00700", session="RTH")


def test_a_remark_is_at_most_64_utf8_bytes():
    _place(remark="q:" + "a" * 62)
    with pytest.raises(OrderRuleError, match="64"):
        _place(remark="q:" + "a" * 63)
    # 22 three-byte characters are 66 bytes though only 22 characters long.
    with pytest.raises(OrderRuleError, match="64"):
        _place(remark="中" * 22)


def test_modify_needs_some_change():
    with pytest.raises(OrderRuleError, match="at least one"):
        check_modify_order(price=None, qty=None, trigger_price=None, trail_type=None, trail_value=None, trail_spread=None)


def test_modify_trail_value_and_type_go_together():
    with pytest.raises(OrderRuleError, match="trail_type"):
        check_modify_order(price=None, qty=None, trigger_price=None, trail_type=None, trail_value=3.0, trail_spread=None)
    with pytest.raises(OrderRuleError, match="trail_value"):
        check_modify_order(price=None, qty=None, trigger_price=None, trail_type="RATIO", trail_value=None, trail_spread=None)
    check_modify_order(price=None, qty=None, trigger_price=None, trail_type="RATIO", trail_value=3.0, trail_spread=None)
    check_modify_order(price=None, qty=None, trigger_price=None, trail_type=None, trail_value=None, trail_spread=0.2)
