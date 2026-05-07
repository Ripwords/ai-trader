from fastapi import Depends, FastAPI

from app.deps import require_internal_bearer
from app.routers import health, quote, watchlist


def create_app() -> FastAPI:
    app = FastAPI(title="ai-trader-api", version="0.1.0")
    app.include_router(health.router)
    app.include_router(quote.router)
    app.include_router(watchlist.router)

    @app.get("/_internal/whoami", dependencies=[Depends(require_internal_bearer)])
    async def whoami() -> dict[str, str]:
        return {"caller": "internal"}

    return app


app = create_app()
