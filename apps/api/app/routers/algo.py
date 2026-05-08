"""HTTP surface for algo trading: strategy CRUD, backtest, kill switch."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import get_opend, require_internal_bearer
from app.schemas.algo import (
    AlgoState,
    BacktestRequest,
    BacktestResult,
    SignalRecord,
    Strategy,
    StrategyCreate,
    StrategyUpdate,
)
from app.services.algo import repo
from app.services.algo.backtester import run_backtest
from app.services.opend import OpendAdapter, OpendError

router = APIRouter(
    prefix="/algo",
    tags=["algo"],
    dependencies=[Depends(require_internal_bearer)],
)


# --- strategies -----------------------------------------------------------


@router.get("/strategies", response_model=list[Strategy])
async def list_strategies() -> list[Strategy]:
    return await repo.list_strategies()


@router.post(
    "/strategies",
    response_model=Strategy,
    status_code=status.HTTP_201_CREATED,
)
async def create_strategy(body: StrategyCreate) -> Strategy:
    # Validator runs here so authoring errors come back as 422, not 500
    # at first backtest/scheduler tick.
    from app.services.algo.validator import ValidationError, validate

    try:
        validate(body.code)
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)
        )

    return await repo.create_strategy(body)


@router.get("/strategies/{strategy_id}", response_model=Strategy)
async def get_strategy(strategy_id: str) -> Strategy:
    s = await repo.get_strategy(strategy_id)
    if not s:
        raise HTTPException(status_code=404, detail="strategy not found")
    return s


@router.put("/strategies/{strategy_id}", response_model=Strategy)
async def update_strategy(strategy_id: str, body: StrategyUpdate) -> Strategy:
    if body.code is not None:
        from app.services.algo.validator import ValidationError, validate

        try:
            validate(body.code)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=str(e))
    s = await repo.update_strategy(strategy_id, body)
    if not s:
        raise HTTPException(status_code=404, detail="strategy not found")
    return s


@router.delete("/strategies/{strategy_id}", status_code=204)
async def delete_strategy(strategy_id: str) -> None:
    ok = await repo.delete_strategy(strategy_id)
    if not ok:
        raise HTTPException(status_code=404, detail="strategy not found")


# --- backtest -------------------------------------------------------------


@router.post(
    "/strategies/{strategy_id}/backtest", response_model=BacktestResult
)
async def backtest(
    strategy_id: str,
    body: BacktestRequest,
    opend: OpendAdapter = Depends(get_opend),
) -> BacktestResult:
    strategy = await repo.get_strategy(strategy_id)
    if not strategy:
        raise HTTPException(status_code=404, detail="strategy not found")

    # Backtest uses daily bars regardless of the live cadence — short
    # cadences would need way more bars to show meaningful equity curve.
    try:
        kline = opend.get_kline(code=strategy.symbol, ktype="1d", num=body.bars)
    except OpendError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    run_id = await repo.create_run(strategy_id, "backtest")
    result = run_backtest(strategy.code, kline.bars, strategy.qty_per_signal)
    result.run_id = run_id
    await repo.finalise_run(run_id, result)
    return result


@router.get("/runs/{run_id}", response_model=BacktestResult)
async def get_run(run_id: str) -> BacktestResult:
    r = await repo.get_run(run_id)
    if not r:
        raise HTTPException(status_code=404, detail="run not found")
    return r


# --- signals + kill switch ------------------------------------------------


@router.get("/signals", response_model=list[SignalRecord])
async def list_signals(
    strategy_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[SignalRecord]:
    return await repo.list_signals(strategy_id=strategy_id, limit=limit)


@router.get("/state", response_model=AlgoState)
async def algo_state() -> AlgoState:
    return AlgoState(
        kill_active=await repo.get_kill_active(),
        enabled_strategies=await repo.list_enabled_strategy_ids(),
    )


@router.post("/kill", response_model=AlgoState)
async def kill_switch_on() -> AlgoState:
    await repo.set_kill_active(True)
    return await algo_state()


@router.post("/unkill", response_model=AlgoState)
async def kill_switch_off() -> AlgoState:
    await repo.set_kill_active(False)
    return await algo_state()
