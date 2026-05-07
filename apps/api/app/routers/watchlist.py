from fastapi import APIRouter, Body, Depends, HTTPException, Query, status

from app.deps import get_opend, require_internal_bearer
from app.schemas.watchlist import WatchlistItem
from app.services.opend import OpendAdapter, OpendError

router = APIRouter(
    prefix="/watchlist",
    tags=["watchlist"],
    dependencies=[Depends(require_internal_bearer)],
)


@router.get("/list", response_model=list[WatchlistItem])
async def list_(
    group: str = Query("All"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[WatchlistItem]:
    try:
        return opend.list_watchlist(group=group)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/add")
async def add(
    code: str = Body(..., embed=True),
    group: str = Body("All", embed=True),
    opend: OpendAdapter = Depends(get_opend),
) -> dict[str, str]:
    try:
        opend.add_watchlist_item(code, group=group)
        return {"status": "ok"}
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/remove")
async def remove(
    code: str = Body(..., embed=True),
    group: str = Body("All", embed=True),
    opend: OpendAdapter = Depends(get_opend),
) -> dict[str, str]:
    try:
        opend.remove_watchlist_item(code, group=group)
        return {"status": "ok"}
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
