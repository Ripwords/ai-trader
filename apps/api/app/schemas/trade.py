from datetime import datetime
from typing import Literal

from pydantic import BaseModel


TrdEnv = Literal["SIMULATE", "REAL"]
# NORMAL = limit, MARKET = market, STOP = stop-market (trigger only),
# STOP_LIMIT = stop-limit (trigger + limit price). Mirrors moomoo OrderType.
OrderType = Literal["NORMAL", "MARKET", "STOP", "STOP_LIMIT"]


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
    qty: int
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


class Fill(BaseModel):
    fill_id: str
    order_id: str
    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    price: float
    fill_at: datetime


class PlaceOrderRequest(BaseModel):
    code: str
    side: Literal["BUY", "SELL"]
    qty: int
    # price: required for NORMAL and STOP_LIMIT (the limit price), ignored
    # for MARKET and STOP.
    price: float | None = None
    order_type: OrderType = "NORMAL"
    # trigger_price: required for STOP / STOP_LIMIT (moomoo aux_price).
    trigger_price: float | None = None
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str | None = None  # string on wire (see Account.acc_id note); None = first SIMULATE


class ModifyOrderRequest(BaseModel):
    order_id: str
    price: float | None = None
    qty: int | None = None
    # New trigger price when modifying a STOP / STOP_LIMIT (moomoo aux_price).
    trigger_price: float | None = None
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str


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
