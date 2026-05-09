"""HTTP surface for the deterministic research analysts.

Bundle data is fetched on the web side (apps/web/server/lib/yahoo.ts via
yahoo-finance2) and passed in the request body. apps/api stays a stateless
scoring layer."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_opend, require_internal_bearer
from app.schemas.research import (
    AnalystRequest,
    FundamentalsRequest,
    SentimentRequest,
    Signal,
    ValuationRequest,
)
from app.services.opend import OpendAdapter, OpendError
from app.services.research.fundamentals_analyst import score_fundamentals
from app.services.research.sentiment_analyst import score_sentiment
from app.services.research.technicals_analyst import score_technicals
from app.services.research.valuation_analyst import score_valuation

router = APIRouter(
    prefix="/research",
    tags=["research"],
    dependencies=[Depends(require_internal_bearer)],
)


@router.post("/fundamentals", response_model=Signal)
async def fundamentals(body: FundamentalsRequest) -> Signal:
    return score_fundamentals(body.symbol, body.metrics)


@router.post("/valuation", response_model=Signal)
async def valuation(body: ValuationRequest) -> Signal:
    return score_valuation(body.symbol, body.metrics)


@router.post("/technicals", response_model=Signal)
async def technicals(
    body: AnalystRequest, opend: OpendAdapter = Depends(get_opend)
) -> Signal:
    try:
        kline = await asyncio.to_thread(
            lambda: opend.get_kline(code=body.symbol, ktype="1d", num=200)
        )
    except OpendError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return score_technicals(body.symbol, kline.bars)


@router.post("/sentiment", response_model=Signal)
async def sentiment(body: SentimentRequest) -> Signal:
    return score_sentiment(body.symbol, body.insider, body.news)
