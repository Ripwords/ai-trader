from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import get_opend, require_internal_bearer
from app.schemas.trade import Account, Fill, Order, Portfolio, TrdEnv
from app.services.opend import OpendAdapter, OpendError

router = APIRouter(
    prefix="/trade",
    tags=["trade"],
    dependencies=[Depends(require_internal_bearer)],
)


@router.get("/accounts", response_model=list[Account])
async def accounts(opend: OpendAdapter = Depends(get_opend)) -> list[Account]:
    try:
        return opend.list_accounts()
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/portfolio", response_model=Portfolio)
async def portfolio(
    acc_id: int = Query(...),
    trd_env: TrdEnv = Query("SIMULATE"),
    opend: OpendAdapter = Depends(get_opend),
) -> Portfolio:
    try:
        return opend.get_portfolio(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/orders", response_model=list[Order])
async def orders(
    acc_id: int = Query(...),
    trd_env: TrdEnv = Query("SIMULATE"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Order]:
    try:
        return opend.list_orders(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.get("/fills", response_model=list[Fill])
async def fills(
    acc_id: int = Query(...),
    trd_env: TrdEnv = Query("SIMULATE"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Fill]:
    try:
        return opend.list_fills(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
