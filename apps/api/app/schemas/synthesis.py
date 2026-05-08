# Ported from virattt/ai-hedge-fund src/agents/risk_manager.py + portfolio_manager.py.

from typing import Literal

from pydantic import BaseModel, Field

ActionType = Literal["buy", "sell", "short", "cover", "hold"]
SignalType = Literal["bullish", "bearish", "neutral"]
VolatilityBucket = Literal["low", "medium", "high", "very_high"]


class Signal(BaseModel):
    source: str
    symbol: str
    signal: SignalType
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    metadata: dict | None = None


class PortfolioSnapshot(BaseModel):
    cash: float
    total_value: float
    positions: dict[str, float] = Field(default_factory=dict)


class RiskRequest(BaseModel):
    symbol: str
    portfolio: PortfolioSnapshot


class RiskSizing(BaseModel):
    symbol: str
    volatility_bucket: VolatilityBucket
    max_position_pct: float
    correlation_multiplier: float
    max_position_usd: float
    remaining_position_usd: float


class DecideRequest(BaseModel):
    symbols: list[str]
    signals: list[Signal]
    portfolio: PortfolioSnapshot


class Decision(BaseModel):
    symbol: str
    action: ActionType
    quantity: int
    confidence: int = Field(ge=0, le=100)
    reasoning: str


class DecideResponse(BaseModel):
    decisions: list[Decision]
