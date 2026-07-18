import asyncio
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

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
    trade,
    valuation,
    watchlist,
)
from app.services.algo import repo as algo_repo
from app.services.algo.scheduler import (
    AccountSummary,
    Scheduler,
    install_scheduler,
)
from app.services.paper_orders import record_paper_order
from app.settings import get_settings


_AGENTS_KTYPE_MAP = {
    "K_1M": "1m", "K_3M": "3m", "K_5M": "5m", "K_15M": "15m",
    "K_30M": "30m", "K_60M": "60m", "K_DAY": "1d", "K_WEEK": "1w",
    "K_MON": "1M",
}


class _AgentsOpenDClient:
    """Async-compatible bridge from the agents toolkit/reflection to the sync
    :class:`OpendAdapter`.

    The toolkit and reflection were written against an async client that
    accepts SDK-style ktype strings (``K_DAY``); the production adapter is
    sync and accepts adapter-style ktype strings (``1d``). This bridge:

    1. Resolves the adapter lazily so a missing/down OpenD doesn't crash
       startup or break unrelated requests.
    2. Translates ``K_DAY``-style ktypes to the adapter's ``1d``-style.
    3. Routes the sync call through :func:`asyncio.to_thread`.
    4. Returns the raw :class:`KLineResponse`; consumers already coerce its
       ``.bars`` via :func:`_kline_bars` / :func:`_maybe_await_kline`.
    """

    def __init__(self, host: str, port: int, rsa_key_path: str | None = None) -> None:
        self._host = host
        self._port = port
        self._rsa_key_path = rsa_key_path

    async def get_kline(self, ticker: str, ktype: str, num: int) -> Any:
        adapter_ktype = _AGENTS_KTYPE_MAP.get(ktype, ktype)
        return await asyncio.to_thread(
            lambda: _build_adapter(self._host, self._port, self._rsa_key_path).get_kline(
                code=ticker, ktype=adapter_ktype, num=num
            )
        )


def _make_opend_bridges():
    """Return (get_klines, get_position, get_account_summary, place_paper_order)
    callables that wrap the sync OpendAdapter into asyncio. We resolve the
    adapter lazily so a missing/down OpenD doesn't crash app startup."""
    settings = get_settings()

    def _adapter():
        return _build_adapter(settings.OPEND_HOST, settings.OPEND_PORT, settings.OPEND_RSA_KEY_PATH)

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
        def _do():
            ad = _adapter()
            return ad.place_order(
                code=symbol,
                side=side,  # type: ignore[arg-type]
                qty=qty,
                price=None,
                order_type="MARKET",
                trd_env="SIMULATE",
                acc_id=None,
            )

        res = await asyncio.to_thread(_do)
        # Best-effort paper_orders ledger row — record_paper_order never
        # raises, so a ledger/db hiccup can't fail the order we just placed.
        await record_paper_order(
            source="algo",
            symbol=res.code,
            side=res.side,
            qty=res.qty,
            moomoo_order_id=res.order_id,
            acc_id=res.acc_id,
            price=res.price,
            order_type="MARKET",
            trd_env="SIMULATE",
            status=res.status,
            raw=res.model_dump(mode="json"),
        )
        return res.order_id

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


# LangGraph's AsyncPostgresSaver doesn't expose a schema kwarg, so we isolate
# its tables (``checkpoints`` / ``checkpoint_blobs`` / ``checkpoint_writes``)
# from the rest of ``public`` by routing every connection's ``search_path``
# through ``langgraph`` first. The ``configure`` callback runs once per new
# connection acquired by the pool — both the initial ``saver.setup()`` (which
# CREATEs the tables) and every later ``saver.aput`` / ``saver.aget`` end up
# resolving unqualified names against ``langgraph`` first, so the tables
# land — and stay — in that schema.
async def _configure_checkpointer_connection(conn: Any) -> None:
    await conn.execute("SET search_path TO langgraph, public")


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
    app.state.opend_client = _AgentsOpenDClient(
        settings.OPEND_HOST,
        settings.OPEND_PORT,
        settings.OPEND_RSA_KEY_PATH,
    )
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
            # CREATE the schema on a one-shot connection before the pool
            # opens so the search_path the pool's ``configure`` callback
            # sets has somewhere to land.
            import psycopg

            async with await psycopg.AsyncConnection.connect(
                psycopg_dsn, autocommit=True
            ) as bootstrap_conn:
                await bootstrap_conn.execute("CREATE SCHEMA IF NOT EXISTS langgraph")

            checkpointer_pool = AsyncConnectionPool(
                psycopg_dsn,
                min_size=1,
                max_size=4,
                kwargs={"autocommit": True, "prepare_threshold": 0},
                open=False,
                configure=_configure_checkpointer_connection,
            )
            await checkpointer_pool.open(wait=True, timeout=10.0)
            saver = AsyncPostgresSaver(conn=checkpointer_pool)
            # ``saver.setup()`` is idempotent and creates the checkpoints /
            # checkpoint_blobs / checkpoint_writes tables. With search_path
            # pinned to ``langgraph, public``, those CREATEs land in the
            # ``langgraph`` schema. To verify after startup:
            # ``\dt langgraph.*`` should list all three tables; ``\dt
            # public.checkpoint*`` should be empty.
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
    app.include_router(agents.router)
    app.include_router(valuation.router)

    @app.get("/_internal/whoami", dependencies=[Depends(require_internal_bearer)])
    async def whoami() -> dict[str, str]:
        return {"caller": "internal"}

    return app


app = create_app()
