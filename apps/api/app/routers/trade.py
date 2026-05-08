from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import get_opend, require_internal_bearer
from app.schemas.trade import (
    Account,
    CancelOrderRequest,
    Fill,
    ModifyOrderRequest,
    Order,
    PlaceOrderRequest,
    PlaceOrderResult,
    Portfolio,
    TrdEnv,
)
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


@router.post("/order/place", response_model=PlaceOrderResult)
async def place_order(
    body: PlaceOrderRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> PlaceOrderResult:
    try:
        return opend.place_order(
            code=body.code,
            side=body.side,
            qty=body.qty,
            price=body.price,
            order_type=body.order_type,
            trd_env=body.trd_env,
            acc_id=body.acc_id,
        )
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/order/modify")
async def modify_order(
    body: ModifyOrderRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> dict[str, str]:
    try:
        return opend.modify_order(
            order_id=body.order_id,
            acc_id=body.acc_id,
            price=body.price,
            qty=body.qty,
            trd_env=body.trd_env,
        )
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post("/order/cancel")
async def cancel_order(
    body: CancelOrderRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> dict[str, str]:
    try:
        return opend.cancel_order(
            order_id=body.order_id,
            acc_id=body.acc_id,
            trd_env=body.trd_env,
        )
    except OpendError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
