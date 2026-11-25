from datetime import datetime
from typing import Literal

from pydantic import BaseModel, model_validator

from app.services.order_rules import (
    OrderType,
    Session,
    TimeInForce,
    TrailType,
    TrdEnv,
    check_modify_order,
    check_place_order,
)

__all__ = ["OrderType", "Session", "TimeInForce", "TrailType", "TrdEnv"]


class Account(BaseModel):
    # acc_id is a string (not int) on the wire because moomoo IDs exceed
    # JavaScript's Number.MAX_SAFE_INTEGER (2^53-1 = 9007199254740991).
    # Live IDs like 286260079832225550 silently round to 286260079832225540
    # when parsed as a JS number, which then doesn't match any account.
    acc_id: str
    trd_env: TrdEnv
    acc_type: str  # "CASH" | "MARGIN"
    card_num: str | None = None
    security_firm: str | None = None
    trdmarket_auth: list[str] = []
    acc_role: str | None = None


class Position(BaseModel):
    code: str
    qty: float
    cost_price: float
    current_price: float
    market_val: float
    pl_val: float
    pl_ratio: float
    # Settlement currency of this position (e.g. "USD", "HKD"). None when the
    # SDK/account doesn't report it. Never assume USD downstream.
    currency: str | None = None


class Portfolio(BaseModel):
    cash: float
    market_val: float
    total_assets: float
    positions: list[Position]
    # REPORTING currency of the scalar cash/market_val/total_assets figures.
    # This is NOT a broker fact: moomoo exposes no per-account base currency
    # (get_acc_list has no currency column), and accinfo_query converts the
    # scalars into whatever currency the caller asks for. We request
    # MOOMOO_REPORT_CURRENCY and OpenD echoes it here. The scalar `cash` is
    # therefore every currency's cash CONVERTED into this unit — NOT a native
    # balance. Do not present it as money the user holds; use cash_by_currency.
    currency: str | None = None
    # Always "requested" — a marker that `currency` reflects our request rather
    # than a currency the account intrinsically reports in, so no consumer
    # mistakes the converted total for a native balance.
    reporting_currency_source: Literal["requested"] = "requested"
    # Native cash the user actually holds, keyed by real currency
    # (e.g. {"USD": 1634.12}). Built from moomoo's per-currency *_cash columns.
    # This is the truth about what currencies are held; prefer it over the
    # base-currency `cash`/`currency` when telling the user what they own.
    cash_by_currency: dict[str, float] = {}


class Order(BaseModel):
    order_id: str
    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    price: float
    status: str
    created_at: datetime
    # The trigger (moomoo aux_price) of a STOP / STOP_LIMIT / *_IF_TOUCHED
    # order, or the current stop of a trailing one.
    trigger_price: float | None = None
    # The account the order was listed from. moomoo's rows don't carry it;
    # list_orders fills it from the query. None on history rows built elsewhere.
    acc_id: str | None = None
    trd_env: TrdEnv | None = None
    # Plain strings, not the request Literals: moomoo can report types and
    # values this app never places (e.g. ABSOLUTE_LIMIT, IOC). None when absent
    # or "N/A".
    order_type: str | None = None
    time_in_force: str | None = None
    session: str | None = None
    dealt_qty: float | None = None
    remark: str | None = None
    trail_type: str | None = None
    trail_value: float | None = None
    trail_spread: float | None = None


class Fill(BaseModel):
    fill_id: str
    order_id: str
    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    price: float
    fill_at: datetime


class PlaceOrderRequest(BaseModel):
    """Rules live in app.services.order_rules.check_place_order; a request
    that breaks one fails validation (422) before anything is sent."""

    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    # The limit price: required for NORMAL, STOP_LIMIT and LIMIT_IF_TOUCHED;
    # dropped for every other type.
    price: float | None = None
    order_type: OrderType = "NORMAL"
    # moomoo aux_price: required for STOP, STOP_LIMIT, MARKET_IF_TOUCHED and
    # LIMIT_IF_TOUCHED; dropped for every other type.
    trigger_price: float | None = None
    # Required for TRAILING_STOP and TRAILING_STOP_LIMIT; trail_spread (the
    # limit's distance from the stop) for TRAILING_STOP_LIMIT only.
    trail_type: TrailType | None = None
    trail_value: float | None = None
    trail_spread: float | None = None
    time_in_force: TimeInForce = "DAY"
    session: Session = "RTH"
    # Attached to the order by moomoo and echoed back in the order list.
    remark: str | None = None
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str | None = None  # string on wire (see Account.acc_id note); None = first SIMULATE

    @model_validator(mode="after")
    def _follows_order_rules(self) -> "PlaceOrderRequest":
        sent = check_place_order(
            code=self.code,
            order_type=self.order_type,
            trd_env=self.trd_env,
            price=self.price,
            trigger_price=self.trigger_price,
            trail_type=self.trail_type,
            trail_value=self.trail_value,
            trail_spread=self.trail_spread,
            time_in_force=self.time_in_force,
            session=self.session,
            remark=self.remark,
        )
        self.price = sent["price"]
        self.trigger_price = sent["trigger_price"]
        return self


class ModifyOrderRequest(BaseModel):
    order_id: str
    price: float | None = None
    qty: int | None = None
    # New trigger price (moomoo aux_price) for a triggered order.
    trigger_price: float | None = None
    # New trail for a trailing order; trail_type and trail_value go together.
    trail_type: TrailType | None = None
    trail_value: float | None = None
    trail_spread: float | None = None
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str

    @model_validator(mode="after")
    def _follows_order_rules(self) -> "ModifyOrderRequest":
        check_modify_order(
            price=self.price,
            qty=self.qty,
            trigger_price=self.trigger_price,
            trail_type=self.trail_type,
            trail_value=self.trail_value,
            trail_spread=self.trail_spread,
        )
        return self


class CancelOrderRequest(BaseModel):
    order_id: str
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str


class PlaceOrderResult(BaseModel):
    order_id: str
    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    price: float
    status: str
    trd_env: TrdEnv
    acc_id: str
