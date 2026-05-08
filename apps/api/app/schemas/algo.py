"""Pydantic schemas for the algo trading surface (strategies, runs, signals)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Cadence = Literal["1m", "5m", "15m", "1h", "1d"]
Side = Literal["BUY", "SELL"]
RunKind = Literal["backtest", "live_signal"]
RunStatus = Literal["pending", "running", "ok", "error"]


class StrategyBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=32)
    cadence: Cadence
    qty_per_signal: int = Field(default=1, ge=1)
    code: str = Field(min_length=1)


class StrategyCreate(StrategyBase):
    pass


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    symbol: str | None = Field(default=None, min_length=1, max_length=32)
    cadence: Cadence | None = None
    qty_per_signal: int | None = Field(default=None, ge=1)
    code: str | None = Field(default=None, min_length=1)
    enabled: bool | None = None


class Strategy(StrategyBase):
    id: str
    enabled: bool
    created_at: datetime
    updated_at: datetime


class BacktestRequest(BaseModel):
    bars: int = Field(default=200, ge=10, le=2000)


class TradeRecord(BaseModel):
    ts: datetime
    side: Side
    qty: int
    price: float
    pnl: float = 0.0


class EquityPoint(BaseModel):
    t: datetime
    v: float


class Metrics(BaseModel):
    pnl: float
    win_rate: float
    max_dd: float
    sharpe: float
    n_trades: int


class BacktestResult(BaseModel):
    run_id: str
    status: RunStatus
    equity_curve: list[EquityPoint] = []
    trades: list[TradeRecord] = []
    metrics: Metrics | None = None
    error: str | None = None


class SignalRecord(BaseModel):
    id: int
    strategy_id: str
    ts: datetime
    side: Side
    qty: int
    price: float | None = None
    order_id: str | None = None
    error: str | None = None


class AlgoState(BaseModel):
    kill_active: bool
    enabled_strategies: list[str]  # strategy ids currently set enabled=True
