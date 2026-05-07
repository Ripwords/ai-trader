from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


KLineType = Literal["1m", "3m", "5m", "15m", "30m", "60m", "1d", "1w", "1M"]


class Bar(BaseModel):
    time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int
    turnover: float


class KLineResponse(BaseModel):
    code: str
    ktype: KLineType
    bars: list[Bar] = Field(default_factory=list)


class Snapshot(BaseModel):
    code: str
    name: str | None = None
    last_price: float
    open_price: float
    high_price: float
    low_price: float
    prev_close_price: float
    change_rate: float
    volume: int
    turnover: float
    update_time: datetime
