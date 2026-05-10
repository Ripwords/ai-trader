"""Wire schemas for the /agents endpoints."""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field


class RunRequest(BaseModel):
    """POST /agents/run request body.

    `trade_date` defaults to today (UTC) when omitted, set in the router.
    `max_debate_rounds` is bounded to keep paid LLM costs predictable.
    """

    symbol: str = Field(..., min_length=1, max_length=20)
    trade_date: date | None = None
    max_debate_rounds: int = Field(1, ge=1, le=3)
    deep_thinking: bool = True
