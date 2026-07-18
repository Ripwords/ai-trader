import logging

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
from app.settings import Settings, get_settings

logger = logging.getLogger(__name__)


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


def _assert_live_trading_enabled(trd_env: str, settings: Settings) -> None:
    """Server-side kill switch for anything touching real money.

    The web layer already demands a typed confirmation phrase for REAL
    trades; this is defense in depth — a REAL order can't slip through a
    direct API call unless the operator explicitly enabled live trading."""
    if trd_env == "REAL" and not settings.ALLOW_LIVE_TRADING:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Live trading is disabled on this server. Set "
                "ALLOW_LIVE_TRADING=true in the api environment to enable "
                "REAL order placement/modification/cancellation."
            ),
        )


# moomoo order_status values that can no longer consume buying power.
_DEAD_ORDER_STATUS_MARKERS = ("CANCEL", "FAIL", "DELETED", "DISABLED")


def _order_is_dead(order_status: str) -> bool:
    s = order_status.upper()
    return any(marker in s for marker in _DEAD_ORDER_STATUS_MARKERS)


def _assert_live_notional_under_cap(
    body: PlaceOrderRequest, opend: OpendAdapter, settings: Settings
) -> None:
    """Reject a REAL place order that would push today's summed REAL order
    notional over MAX_DAILY_LIVE_NOTIONAL_USD.

    Notional is qty * price with no currency conversion (conservative:
    non-USD notional counts 1:1 as USD). For MARKET/STOP orders without a
    limit price the last traded price from a snapshot is used as the
    estimate; if that estimate can't be obtained we fail closed."""
    if body.acc_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="acc_id is required for REAL orders",
        )

    est_price = body.price
    if est_price is None or est_price <= 0:
        try:
            est_price = opend.get_snapshot(body.code).last_price
        except OpendError as exc:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Cannot estimate notional for this REAL order (no limit "
                    f"price and snapshot failed: {exc}); refusing to place it."
                ),
            ) from exc
    new_notional = body.qty * float(est_price)

    try:
        todays_orders = opend.list_orders(acc_id=body.acc_id, trd_env="REAL")
    except OpendError as exc:
        # Fail closed: if we can't see today's live orders we can't prove
        # the cap holds, so we refuse rather than degrade open.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Cannot verify today's live order notional (order-list query "
                f"failed: {exc}); refusing to place a REAL order."
            ),
        ) from exc
    spent = sum(o.qty * o.price for o in todays_orders if not _order_is_dead(o.status))

    if spent + new_notional > settings.MAX_DAILY_LIVE_NOTIONAL_USD:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Daily live notional cap exceeded: today's REAL orders total "
                f"${spent:.2f} and this order adds ${new_notional:.2f}, above "
                f"the ${settings.MAX_DAILY_LIVE_NOTIONAL_USD:.2f} cap "
                "(MAX_DAILY_LIVE_NOTIONAL_USD)."
            ),
        )


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


@router.post("/order/place", response_model=PlaceOrderResult)
async def place_order(
    body: PlaceOrderRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> PlaceOrderResult:
    settings = get_settings()
    _assert_live_trading_enabled(body.trd_env, settings)
    if body.trd_env == "REAL":
        _assert_live_notional_under_cap(body, opend, settings)
        logger.warning(
            "placing REAL order: %s %s x%s @ %s (%s)",
            body.side, body.code, body.qty, body.price, body.order_type,
        )
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
    _assert_live_trading_enabled(body.trd_env, get_settings())
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
    _assert_live_trading_enabled(body.trd_env, get_settings())
    try:
        return opend.cancel_order(
            order_id=body.order_id,
            acc_id=body.acc_id,
            trd_env=body.trd_env,
        )
    except OpendError as exc:
        raise _opend_to_http(exc) from exc
