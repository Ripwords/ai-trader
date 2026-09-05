import logging
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


# moomoo order_status values that can no longer consume buying power. A
# partially cancelled order (CANCELLED_PART) keeps its filled leg, so only the
# fully-dead states count; "FAIL" also covers SUBMIT_FAILED.
_DEAD_ORDER_STATUS_MARKERS = ("CANCELLED_ALL", "FAIL", "DELETED", "DISABLED", "TIMEOUT")


def _order_is_dead(order_status: str) -> bool:
    s = order_status.upper()
    return any(marker in s for marker in _DEAD_ORDER_STATUS_MARKERS)


def _estimate_price(code: str, price: float | None, opend: OpendAdapter, what: str) -> float:
    """A limit price when there is one, else the last trade from a snapshot.
    Fails closed: a REAL order we cannot price is a REAL order we refuse."""
    if price is not None and price > 0:
        return float(price)
    try:
        return float(opend.get_snapshot(code).last_price)
    except OpendError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot estimate notional for {what} (no limit price and "
                f"snapshot failed: {exc}); refusing it."
            ),
        ) from exc


def _todays_live_orders(acc_id: str, opend: OpendAdapter) -> list[Order]:
    try:
        return opend.list_orders(acc_id=acc_id, trd_env="REAL")
    except OpendError as exc:
        # Fail closed: if we can't see today's live orders we can't prove
        # the cap holds, so we refuse rather than degrade open.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Cannot verify today's live order notional (order-list query "
                f"failed: {exc}); refusing the REAL order."
            ),
        ) from exc


def _assert_live_notional_under_cap(
    *,
    code: str,
    qty: int,
    price: float | None,
    acc_id: str,
    opend: OpendAdapter,
    settings: Settings,
    exclude_order_id: str | None = None,
) -> None:
    """Reject a REAL order (new or modified) that would push today's summed
    REAL order notional over MAX_DAILY_LIVE_NOTIONAL_USD.

    Notional is qty * price with no currency conversion (conservative:
    non-USD notional counts 1:1 as USD). Orders without a limit price
    (MARKET/STOP, which moomoo reports back at price 0) are valued at the
    last traded price from a snapshot; if that estimate can't be obtained we
    fail closed. ``exclude_order_id`` drops the order being modified from the
    spent total so its new size replaces, rather than adds to, its old one."""
    new_notional = qty * _estimate_price(code, price, opend, "this REAL order")

    spent = 0.0
    for o in _todays_live_orders(acc_id, opend):
        if _order_is_dead(o.status) or o.order_id == exclude_order_id:
            continue
        spent += o.qty * _estimate_price(o.code, o.price, opend, f"open REAL order {o.order_id}")

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


def _assert_live_modify_under_cap(
    body: ModifyOrderRequest, opend: OpendAdapter, settings: Settings
) -> None:
    """The modify path can grow an order past the cap just as placement can,
    so it is checked against the same daily total, with the order's current
    size swapped out for its requested size."""
    current = next(
        (o for o in _todays_live_orders(body.acc_id, opend) if o.order_id == body.order_id),
        None,
    )
    if current is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Cannot verify the notional of REAL order {body.order_id}: it is "
                "not among today's live orders; refusing to modify it."
            ),
        )
    _assert_live_notional_under_cap(
        code=current.code,
        qty=body.qty if body.qty is not None else current.qty,
        price=body.price if body.price is not None else current.price,
        acc_id=body.acc_id,
        opend=opend,
        settings=settings,
        exclude_order_id=body.order_id,
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
    settings = get_settings()
    _assert_live_trading_enabled(body.trd_env, settings)
    if body.trd_env == "REAL":
        if body.acc_id is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="acc_id is required for REAL orders",
            )
        _assert_live_notional_under_cap(
            code=body.code, qty=body.qty, price=body.price, acc_id=body.acc_id,
            opend=opend, settings=settings,
        )
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
            trigger_price=body.trigger_price,
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
    settings = get_settings()
    _assert_live_trading_enabled(body.trd_env, settings)
    if body.trd_env == "REAL":
        _assert_live_modify_under_cap(body, opend, settings)
        logger.warning(
            "modifying REAL order %s: price=%s qty=%s trigger=%s",
            body.order_id, body.price, body.qty, body.trigger_price,
        )
    try:
        return opend.modify_order(
            order_id=body.order_id,
            acc_id=body.acc_id,
            price=body.price,
            qty=body.qty,
            trigger_price=body.trigger_price,
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
