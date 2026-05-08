from datetime import datetime
from typing import Literal

from pydantic import BaseModel


TrdEnv = Literal["SIMULATE", "REAL"]
OrderType = Literal["NORMAL", "MARKET"]


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


class Portfolio(BaseModel):
    cash: float
    market_val: float
    total_assets: float
    positions: list[Position]


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
    price: float | None = None  # required for NORMAL (limit), ignored for MARKET
    order_type: OrderType = "NORMAL"
    trd_env: TrdEnv = "SIMULATE"
    acc_id: str | None = None  # string on wire (see Account.acc_id note); None = first SIMULATE


class ModifyOrderRequest(BaseModel):
    order_id: str
    price: float | None = None
    qty: int | None = None
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
