from datetime import datetime
from typing import Literal

from pydantic import BaseModel


TrdEnv = Literal["SIMULATE", "REAL"]


class Account(BaseModel):
    acc_id: int
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
