from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI

from app.deps import require_internal_bearer
from app.routers import algo, health, quote, trade, watchlist
from app.services.algo import repo as algo_repo
from app.settings import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Open the DB pool used by the algo surface, and (when wired) start
    the live scheduler. Shut both down on app exit.
    """
    settings = get_settings()
    if settings.DATABASE_URL:
        await algo_repo.init_pool(settings.DATABASE_URL)
    try:
        yield
    finally:
        await algo_repo.close_pool()


def create_app() -> FastAPI:
    app = FastAPI(title="ai-trader-api", version="0.1.0", lifespan=lifespan)
    app.include_router(health.router)
    app.include_router(quote.router)
    app.include_router(watchlist.router)
    app.include_router(trade.router)
    app.include_router(algo.router)

    @app.get("/_internal/whoami", dependencies=[Depends(require_internal_bearer)])
    async def whoami() -> dict[str, str]:
        return {"caller": "internal"}

    return app


app = create_app()
