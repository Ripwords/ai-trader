import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI

from app.deps import _build_adapter, require_internal_bearer
from app.routers import algo, health, quote, research, synthesis, trade, watchlist
from app.services.algo import repo as algo_repo
from app.services.algo.scheduler import (
    AccountSummary,
    Scheduler,
    install_scheduler,
)
from app.settings import get_settings


def _make_opend_bridges():
    """Return (get_klines, get_position, get_account_summary, place_paper_order)
    callables that wrap the sync OpendAdapter into asyncio. We resolve the
    adapter lazily so a missing/down OpenD doesn't crash app startup."""
    settings = get_settings()

    def _adapter():
        return _build_adapter(settings.OPEND_HOST, settings.OPEND_PORT)

    async def get_klines(symbol: str, num: int):
        return await asyncio.to_thread(
            lambda: _adapter().get_kline(code=symbol, ktype="1d", num=num).bars
        )

    async def get_position(symbol: str) -> int:
        def _do() -> int:
            ad = _adapter()
            for acc in ad.list_accounts():
                if acc.trd_env != "SIMULATE":
                    continue
                try:
                    pf = ad.get_portfolio(acc_id=acc.acc_id, trd_env="SIMULATE")
                except Exception:
                    continue
                for p in pf.positions:
                    if p.code == symbol:
                        return int(p.qty)
            return 0

        return await asyncio.to_thread(_do)

    async def get_account_summary() -> AccountSummary:
        def _do() -> AccountSummary:
            ad = _adapter()
            for acc in ad.list_accounts():
                if acc.trd_env != "SIMULATE":
                    continue
                try:
                    pf = ad.get_portfolio(acc_id=acc.acc_id, trd_env="SIMULATE")
                except Exception:
                    continue
                return AccountSummary(
                    cash=float(pf.cash),
                    total_assets=float(pf.total_assets),
                )
            return AccountSummary(cash=0.0, total_assets=0.0)

        return await asyncio.to_thread(_do)

    async def place_paper_order(symbol: str, side: str, qty: int) -> str | None:
        def _do() -> str | None:
            ad = _adapter()
            res = ad.place_order(
                code=symbol,
                side=side,  # type: ignore[arg-type]
                qty=qty,
                price=None,
                order_type="MARKET",
                trd_env="SIMULATE",
                acc_id=None,
            )
            return res.order_id

        return await asyncio.to_thread(_do)

    return get_klines, get_position, get_account_summary, place_paper_order


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the algo DB pool and start the live scheduler."""
    settings = get_settings()
    scheduler: Scheduler | None = None
    if settings.DATABASE_URL:
        await algo_repo.init_pool(settings.DATABASE_URL)
        get_klines, get_position, get_account_summary, place = _make_opend_bridges()
        scheduler = Scheduler(
            get_klines=get_klines,
            get_position=get_position,
            get_account_summary=get_account_summary,
            place_paper_order=place,
        )
        install_scheduler(scheduler)
        scheduler.start()
    try:
        yield
    finally:
        if scheduler is not None:
            await scheduler.stop()
        await algo_repo.close_pool()


def create_app() -> FastAPI:
    app = FastAPI(title="ai-trader-api", version="0.1.0", lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(quote.router)
    app.include_router(watchlist.router)
    app.include_router(trade.router)
    app.include_router(algo.router)
    app.include_router(research.router)
    app.include_router(synthesis.router)

    @app.get("/_internal/whoami", dependencies=[Depends(require_internal_bearer)])
    async def whoami() -> dict[str, str]:
        return {"caller": "internal"}

    return app


app = create_app()
