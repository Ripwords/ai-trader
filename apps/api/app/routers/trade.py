from datetime import date, timedelta

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


def _opend_to_http(exc: OpendError) -> HTTPException:
    """Map OpendError → the right HTTP status. 'does not support' / IPO-account
    rejections aren't a gateway problem — the agent should treat them as a
    bad-input case (4xx) and pick a different account / interface."""
    msg = str(exc)
    if "does not support" in msg or "IPO account" in msg:
        return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=msg)
    if "unlock needed" in msg.lower() or "trade is locked" in msg.lower():
        return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=msg)
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=msg)

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
        raise _opend_to_http(exc) from exc


@router.get("/portfolio", response_model=Portfolio)
async def portfolio(
    acc_id: str = Query(...),
    trd_env: TrdEnv = Query("REAL"),
    opend: OpendAdapter = Depends(get_opend),
) -> Portfolio:
    try:
        return opend.get_portfolio(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise _opend_to_http(exc) from exc


@router.get("/orders", response_model=list[Order])
async def orders(
    acc_id: str = Query(...),
    trd_env: TrdEnv = Query("REAL"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Order]:
    try:
        return opend.list_orders(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise _opend_to_http(exc) from exc


@router.get("/fills", response_model=list[Fill])
async def fills(
    acc_id: str = Query(...),
    trd_env: TrdEnv = Query("REAL"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Fill]:
    try:
        return opend.list_fills(acc_id=acc_id, trd_env=trd_env)
    except OpendError as exc:
        raise _opend_to_http(exc) from exc


def _default_history_range(start: str | None, end: str | None) -> tuple[str, str]:
    """Fill missing bounds: end → today, start → 30 days before end."""
    end_date = date.fromisoformat(end) if end else date.today()
    start_date = date.fromisoformat(start) if start else end_date - timedelta(days=30)
    return start_date.isoformat(), end_date.isoformat()


@router.get("/orders/history", response_model=list[Order])
async def orders_history(
    acc_id: str = Query(...),
    trd_env: TrdEnv = Query("REAL"),
    start: str | None = Query(None, description="YYYY-MM-DD (default: 30 days before end)"),
    end: str | None = Query(None, description="YYYY-MM-DD (default: today)"),
    code: str | None = Query(None, description="optional symbol filter like US.NVDA"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Order]:
    start_s, end_s = _default_history_range(start, end)
    try:
        return opend.list_history_orders(
            acc_id=acc_id, trd_env=trd_env, start=start_s, end=end_s, code=code or ""
        )
    except OpendError as exc:
        raise _opend_to_http(exc) from exc


@router.get("/fills/history", response_model=list[Fill])
async def fills_history(
    acc_id: str = Query(...),
    trd_env: TrdEnv = Query("REAL"),
    start: str | None = Query(None, description="YYYY-MM-DD (default: 30 days before end)"),
    end: str | None = Query(None, description="YYYY-MM-DD (default: today)"),
    code: str | None = Query(None, description="optional symbol filter like US.NVDA"),
    opend: OpendAdapter = Depends(get_opend),
) -> list[Fill]:
    start_s, end_s = _default_history_range(start, end)
    try:
        return opend.list_history_fills(
            acc_id=acc_id, trd_env=trd_env, start=start_s, end=end_s, code=code or ""
        )
    except OpendError as exc:
        raise _opend_to_http(exc) from exc


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
        raise _opend_to_http(exc) from exc


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
        raise _opend_to_http(exc) from exc


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
        raise _opend_to_http(exc) from exc
