# Ported from virattt/ai-hedge-fund src/agents/{risk_manager,portfolio_manager}.py.
"""HTTP surface for synthesis: per-symbol risk sizing + portfolio decisions."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_opend, require_internal_bearer
from app.schemas.synthesis import (
    DecideRequest,
    DecideResponse,
    RiskRequest,
    RiskSizing,
)
from app.services.opend import OpendAdapter, OpendError
from app.services.synthesis.portfolio_manager import decide as decide_service
from app.services.synthesis.risk_manager import compute_risk_sizing

router = APIRouter(
    prefix="/synthesis",
    tags=["synthesis"],
    dependencies=[Depends(require_internal_bearer)],
)


@router.post("/risk", response_model=RiskSizing)
async def compute_risk(
    body: RiskRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> RiskSizing:
    try:
        return await compute_risk_sizing(body.symbol, body.portfolio, opend)
    except OpendError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/decide", response_model=DecideResponse)
async def decide(
    body: DecideRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> DecideResponse:
    try:
        return await decide_service(body.symbols, body.signals, body.portfolio, opend)
    except OpendError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
