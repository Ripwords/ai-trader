"""Pydantic schemas for the algo trading surface (strategies, runs, signals)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.quote import Bar

Cadence = Literal["1m", "5m", "15m", "1h", "1d"]
Side = Literal["BUY", "SELL"]
RunKind = Literal["backtest", "live_signal"]
RunStatus = Literal["pending", "running", "ok", "error"]
SizingMode = Literal["fixed_qty", "pct_equity", "fixed_cash"]


class StrategyBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    symbol: str = Field(min_length=1, max_length=32)
    cadence: Cadence
    code: str = Field(min_length=1)
    initial_capital: float = Field(default=100_000, gt=0)
    commission_bps: int = Field(default=10, ge=0, le=1000)
    slippage_bps: int = Field(default=5, ge=0, le=1000)
    sizing_mode: SizingMode = "fixed_qty"
    sizing_value: float = Field(default=1, gt=0)
    pyramiding_max: int = Field(default=1, ge=1, le=100)


class StrategyCreate(StrategyBase):
    pass


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    symbol: str | None = Field(default=None, min_length=1, max_length=32)
    cadence: Cadence | None = None
    code: str | None = Field(default=None, min_length=1)
    enabled: bool | None = None
    initial_capital: float | None = Field(default=None, gt=0)
    commission_bps: int | None = Field(default=None, ge=0, le=1000)
    slippage_bps: int | None = Field(default=None, ge=0, le=1000)
    sizing_mode: SizingMode | None = None
    sizing_value: float | None = Field(default=None, gt=0)
    pyramiding_max: int | None = Field(default=None, ge=1, le=100)


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
    fills: int
    round_trips: int
    wins: int
    losses: int
    benchmark_pnl: float


class BacktestResult(BaseModel):
    run_id: str
    status: RunStatus
    equity_curve: list[EquityPoint] = []
    benchmark_curve: list[EquityPoint] = []
    price_bars: list[Bar] = []
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
    enabled_strategies: list[str]
