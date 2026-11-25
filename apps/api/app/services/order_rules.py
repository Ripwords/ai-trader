"""moomoo's order rules, in one pure function each for placing and modifying.

Sources: the place_order reference and the paper-trading FAQ
(openapi.moomoo.com/moomoo-api-doc/en/trade/place-order.html, qa/trade.html).
Both the request models (so a bad order is a 422) and the adapter (so a
direct caller such as the algo scheduler gets the same answer) call these.
"""
from typing import Literal

TrdEnv = Literal["SIMULATE", "REAL"]
# NORMAL = limit, MARKET = market, STOP = stop-market, STOP_LIMIT = stop-limit,
# MARKET_IF_TOUCHED / LIMIT_IF_TOUCHED = market/limit once a trigger is touched,
# TRAILING_STOP / TRAILING_STOP_LIMIT = a stop that follows the price by a
# trail. Names match the moomoo OrderType constants.
OrderType = Literal[
    "NORMAL",
    "MARKET",
    "STOP",
    "STOP_LIMIT",
    "MARKET_IF_TOUCHED",
    "LIMIT_IF_TOUCHED",
    "TRAILING_STOP",
    "TRAILING_STOP_LIMIT",
]
# GTD is left out: it needs an expire_time and the docs don't confirm it for US.
TimeInForce = Literal["DAY", "GTC"]
# US stocks only. RTH = regular hours, ETH = pre/post market, OVERNIGHT, ALL.
Session = Literal["RTH", "ETH", "OVERNIGHT", "ALL"]
# RATIO is a percentage (5 = 5%); AMOUNT is a price distance.
TrailType = Literal["RATIO", "AMOUNT"]

# The order types whose `price` is the limit the order fills at.
LIMIT_PRICED: frozenset[str] = frozenset({"NORMAL", "STOP_LIMIT", "LIMIT_IF_TOUCHED"})
# The order types moomoo needs a trigger (SDK aux_price) for.
TRIGGERED: frozenset[str] = frozenset({"STOP", "STOP_LIMIT", "MARKET_IF_TOUCHED", "LIMIT_IF_TOUCHED"})
TRAILING: frozenset[str] = frozenset({"TRAILING_STOP", "TRAILING_STOP_LIMIT"})
PAPER_ORDER_TYPES: frozenset[str] = frozenset({"NORMAL", "MARKET"})
REMARK_MAX_BYTES = 64


class OrderRuleError(ValueError):
    """An order moomoo would refuse, caught before it is sent."""


def check_place_order(
    *,
    code: str,
    order_type: str,
    trd_env: str,
    price: float | None,
    trigger_price: float | None,
    trail_type: str | None,
    trail_value: float | None,
    trail_spread: float | None,
    time_in_force: str,
    session: str,
    remark: str | None,
) -> dict[str, float | None]:
    """Raise OrderRuleError for an order moomoo would refuse. Otherwise return
    the price and trigger to send: a field the order type does not use is
    dropped (None), so a stray limit price on a MARKET order can neither
    reach the broker nor shrink the order's value under the live cap."""
    if order_type in LIMIT_PRICED and (price is None or price <= 0):
        raise OrderRuleError(f"price is required for {order_type} orders (the limit price)")
    if order_type in TRIGGERED and (trigger_price is None or trigger_price <= 0):
        raise OrderRuleError(f"trigger_price is required for {order_type} orders")
    if order_type in TRAILING:
        if trail_type is None:
            raise OrderRuleError(f"trail_type (RATIO or AMOUNT) is required for {order_type} orders")
        if trail_value is None or trail_value <= 0:
            raise OrderRuleError(f"a positive trail_value is required for {order_type} orders")
        if order_type == "TRAILING_STOP_LIMIT" and (trail_spread is None or trail_spread < 0):
            raise OrderRuleError("trail_spread is required for TRAILING_STOP_LIMIT orders")
        if order_type == "TRAILING_STOP" and trail_spread is not None:
            raise OrderRuleError("trail_spread applies only to TRAILING_STOP_LIMIT orders")
    elif trail_type is not None or trail_value is not None or trail_spread is not None:
        raise OrderRuleError("trail_type, trail_value and trail_spread apply only to trailing orders")

    if trd_env == "SIMULATE":
        if order_type not in PAPER_ORDER_TYPES:
            raise OrderRuleError(
                f"moomoo paper accounts take only NORMAL and MARKET orders, not {order_type}"
            )
        if time_in_force != "DAY":
            raise OrderRuleError("moomoo paper accounts take DAY orders only")
        if session in ("OVERNIGHT", "ALL"):
            raise OrderRuleError(f"moomoo paper accounts have no overnight session ({session})")

    if session != "RTH" and not code.upper().startswith("US."):
        raise OrderRuleError(f"session {session} applies to US stocks only")
    if order_type == "MARKET" and session != "RTH":
        raise OrderRuleError(f"MARKET orders run in regular hours (RTH) only, not {session}")
    if session in ("OVERNIGHT", "ALL") and order_type != "NORMAL":
        raise OrderRuleError(f"session {session} takes limit (NORMAL) orders only, not {order_type}")

    if remark is not None and len(remark.encode("utf-8")) > REMARK_MAX_BYTES:
        raise OrderRuleError(f"remark is longer than {REMARK_MAX_BYTES} UTF-8 bytes")

    return {
        "price": price if order_type in LIMIT_PRICED else None,
        "trigger_price": trigger_price if order_type in TRIGGERED else None,
    }


def check_modify_order(
    *,
    price: float | None,
    qty: int | None,
    trigger_price: float | None,
    trail_type: str | None,
    trail_value: float | None,
    trail_spread: float | None,
) -> None:
    """A modify must change something, and a trail value means nothing
    without saying whether it is a ratio or an amount."""
    if all(v is None for v in (price, qty, trigger_price, trail_type, trail_value, trail_spread)):
        raise OrderRuleError(
            "modify_order: provide at least one of price, qty, trigger_price, "
            "trail_type, trail_value or trail_spread"
        )
    if trail_value is not None and trail_type is None:
        raise OrderRuleError("trail_type (RATIO or AMOUNT) is required with trail_value")
    if trail_type is not None and trail_value is None:
        raise OrderRuleError("trail_value is required with trail_type")
    if trail_value is not None and trail_value <= 0:
        raise OrderRuleError("trail_value must be positive")
    if trail_spread is not None and trail_spread < 0:
        raise OrderRuleError("trail_spread must not be negative")
