from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import get_opend, require_internal_bearer
from app.schemas.quote import KLineResponse, KLineType, OrderBook, Snapshot
from app.services.opend import OpendAdapter, OpendError

router = APIRouter(
    prefix="/quote",
    tags=["quote"],
    dependencies=[Depends(require_internal_bearer)],
)


@router.get("/snapshot", response_model=Snapshot)
async def snapshot(
    code: str = Query(..., examples=["US.NVDA"]),
    opend: OpendAdapter = Depends(get_opend),
) -> Snapshot:
    try:
        return opend.get_snapshot(code)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/order-book", response_model=OrderBook)
async def order_book(
    code: str = Query(..., examples=["US.NVDA"]),
    num: int = Query(10, ge=1, le=50),
    opend: OpendAdapter = Depends(get_opend),
) -> OrderBook:
    try:
        return opend.get_order_book(code, num=num)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/kline", response_model=KLineResponse)
async def kline(
    code: str = Query(..., examples=["US.NVDA"]),
    ktype: KLineType = Query(..., examples=["1d"]),
    num: int = Query(60, ge=1, le=1000),
    opend: OpendAdapter = Depends(get_opend),
) -> KLineResponse:
    try:
        return opend.get_kline(code, ktype=ktype, num=num)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/state")
async def state(opend: OpendAdapter = Depends(get_opend)) -> dict[str, bool | str | int]:
    """OpenD reachability + login state. Never raises — returns reachable=False
    when OpenD is down so the UI can render a clear status indicator."""
    return opend.get_global_state()
