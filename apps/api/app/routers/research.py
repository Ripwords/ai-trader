"""HTTP surface for the deterministic research analysts."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_opend, require_internal_bearer
from app.schemas.fundamentals import FundamentalsBundle
from app.schemas.research import AnalystRequest, Signal
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


def _import_fundamentals_service():
    """Lazy import — Slice 1 owns app.services.fundamentals. Importing at
    module level would break startup for any deployment where Slice 1 hasn't
    landed yet. The handlers only call this when actually invoked."""
    from app.services import fundamentals as f  # type: ignore[attr-defined]

    return f


@router.post("/fundamentals", response_model=Signal)
async def fundamentals(body: AnalystRequest) -> Signal:
    try:
        f = _import_fundamentals_service()
        metrics = await f.get_financial_metrics(body.symbol)
    except (ImportError, AttributeError) as exc:
        raise HTTPException(status_code=503, detail=f"fundamentals service unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001 — surface upstream failures as 502
        raise HTTPException(status_code=502, detail=f"fundamentals fetch failed: {exc}")
    return score_fundamentals(body.symbol, metrics)


@router.post("/valuation", response_model=Signal)
async def valuation(body: AnalystRequest) -> Signal:
    try:
        f = _import_fundamentals_service()
        metrics = await f.get_financial_metrics(body.symbol)
    except (ImportError, AttributeError) as exc:
        raise HTTPException(status_code=503, detail=f"fundamentals service unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"fundamentals fetch failed: {exc}")
    return score_valuation(body.symbol, metrics)


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
async def sentiment(body: AnalystRequest) -> Signal:
    try:
        f = _import_fundamentals_service()
        insider = await f.get_insider_trades(body.symbol, limit=200)
        news = await f.get_company_news(body.symbol, limit=50)
    except (ImportError, AttributeError) as exc:
        raise HTTPException(status_code=503, detail=f"fundamentals service unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"sentiment fetch failed: {exc}")
    return score_sentiment(body.symbol, insider, news)


@router.post("/bundle", response_model=FundamentalsBundle)
async def bundle(body: AnalystRequest) -> FundamentalsBundle:
    try:
        f = _import_fundamentals_service()
        return await f.get_fundamentals_bundle(body.symbol)
    except (ImportError, AttributeError) as exc:
        raise HTTPException(status_code=503, detail=f"fundamentals service unavailable: {exc}")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"bundle fetch failed: {exc}")
