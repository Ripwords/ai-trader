"""Pydantic schemas for the deterministic research analyst surface."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

SignalType = Literal["bullish", "bearish", "neutral"]


class Signal(BaseModel):
    source: str
    symbol: str
    signal: SignalType
    confidence: int = Field(ge=0, le=100)
    reasoning: str
    metadata: dict[str, Any] | None = None


class AnalystRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
