import asyncio
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg
from fastapi import Depends, FastAPI
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool

from app.deps import _build_adapter, require_internal_bearer
from app.routers import (
    agents,
    algo,
    health,
    quote,
    research,
    synthesis,
    trade,
    watchlist,
)
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


def _to_psycopg_dsn(url: str) -> str:
    """Translate a SQLAlchemy/asyncpg DSN to a libpq-compatible one for psycopg.

    Drizzle and asyncpg accept ``postgresql+asyncpg://`` and similar driver
    suffixes; libpq (used by psycopg, which AsyncPostgresSaver wraps) only
    speaks ``postgresql://``. This is a one-line normalizer rather than a full
    URL parser because the only suffix we ever produce is ``+<driver>``.
    """
    if "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    return f"{scheme.split('+', 1)[0]}://{rest}"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the algo DB pool, the agents memory pool, and start the scheduler.

    The agents memory pool is separate from ``algo_repo``'s pool so memory
    recall can fail independently of algo persistence; both share
    ``settings.DATABASE_URL``. ``app.state.pg_pool`` is what
    :func:`app.routers.agents._recall_memory` looks up.

    Additionally, when ``DATABASE_URL`` is set, we open a small psycopg pool
    for :class:`AsyncPostgresSaver` (LangGraph's Postgres checkpointer) and
    expose it on ``app.state.checkpointer``. ``saver.setup()`` is idempotent
    — it creates the ``checkpoints`` / ``checkpoint_blobs`` / ``checkpoint_writes``
    tables on first run and is a no-op afterwards. The saver currently writes
    to the ``public`` schema (AsyncPostgresSaver doesn't expose a
    ``schema`` kwarg in 2.0.x); a follow-up can isolate via ``search_path``.
    Failures here are logged and ``app.state.checkpointer`` stays ``None`` —
    the router degrades to "no checkpoint, resume always restarts" rather
    than blocking startup.
    """
    settings = get_settings()
    scheduler: Scheduler | None = None
    pg_pool: asyncpg.Pool | None = None
    checkpointer_pool: AsyncConnectionPool | None = None
    app.state.checkpointer = None
    if settings.DATABASE_URL:
        await algo_repo.init_pool(settings.DATABASE_URL)
        try:
            pg_pool = await asyncpg.create_pool(
                settings.DATABASE_URL, min_size=1, max_size=5
            )
            app.state.pg_pool = pg_pool
        except Exception as e:  # noqa: BLE001
            print(f"[agents] Failed to create asyncpg pool: {e}")
        try:
            psycopg_dsn = _to_psycopg_dsn(settings.DATABASE_URL)
            checkpointer_pool = AsyncConnectionPool(
                psycopg_dsn,
                min_size=1,
                max_size=4,
                kwargs={"autocommit": True, "prepare_threshold": 0},
                open=False,
            )
            await checkpointer_pool.open(wait=True, timeout=10.0)
            saver = AsyncPostgresSaver(conn=checkpointer_pool)
            await saver.setup()
            app.state.checkpointer = saver
        except Exception as e:  # noqa: BLE001
            print(f"[agents] Failed to init checkpointer: {e}")
            if checkpointer_pool is not None:
                await checkpointer_pool.close()
                checkpointer_pool = None
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
        if checkpointer_pool is not None:
            await checkpointer_pool.close()
        if pg_pool is not None:
            await pg_pool.close()
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
    app.include_router(agents.router)

    @app.get("/_internal/whoami", dependencies=[Depends(require_internal_bearer)])
    async def whoami() -> dict[str, str]:
        return {"caller": "internal"}

    return app


app = create_app()
