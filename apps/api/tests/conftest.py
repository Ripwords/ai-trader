import os
from collections.abc import Iterator
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

# Set agent-related env defaults BEFORE importing app modules so anything that
# reads them at import time (settings, model_config) gets sane test values.
os.environ.setdefault("INTERNAL_BEARER", "test-bearer")
os.environ.setdefault("LLM_MODEL", "anthropic/claude-sonnet-4-6")

from app.deps import get_opend  # noqa: E402
from app.main import create_app  # noqa: E402
from app.settings import get_settings  # noqa: E402
from tests.test_quote import FakeAdapter  # noqa: E402


@pytest.fixture
def client() -> Iterator[TestClient]:
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


@pytest.fixture
def client_with_bearer(monkeypatch) -> Iterator[TestClient]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    c = TestClient(create_app())
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    get_settings.cache_clear()


@pytest.fixture
def client_with_bearer_and_fake(monkeypatch) -> Iterator[TestClient]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: FakeAdapter()
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture
def fake_watchlist_adapter():
    from tests.test_watchlist import FakeAdapter as WatchlistFakeAdapter
    return WatchlistFakeAdapter()


@pytest.fixture
def client_with_bearer_and_fake_watchlist(monkeypatch, fake_watchlist_adapter) -> Iterator[TestClient]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: fake_watchlist_adapter
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture
def fake_trade_adapter():
    from tests.test_trade import FakeTradeAdapter
    return FakeTradeAdapter()


@pytest.fixture
def client_with_bearer_and_fake_trade(monkeypatch, fake_trade_adapter) -> Iterator[TestClient]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: fake_trade_adapter
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    app.dependency_overrides.clear()
    get_settings.cache_clear()


@pytest.fixture(scope="session")
def pg_container():
    """Boot a postgres testcontainer once per session.

    Starting Postgres takes several seconds; we amortise that cost across all
    tests in the session and only stop it at session teardown. Schema bring-up
    happens here too so each per-test pool sees an already-migrated DB.

    Skipped silently if Docker isn't available (e.g., CI without DinD) — the
    rest of the suite stays green.
    """
    try:
        from testcontainers.postgres import PostgresContainer

        pg = PostgresContainer("postgres:16-alpine")
        pg.start()
    except Exception as e:
        pytest.skip(f"Postgres container unavailable: {e}")

    url = pg.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")

    # Apply schema synchronously via a short-lived asyncpg connection.
    import asyncio

    async def _apply_schema() -> None:
        conn = await asyncpg.connect(url)
        try:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto;")
            await conn.execute(
                "CREATE TABLE IF NOT EXISTS users("
                "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
                "  name text NOT NULL UNIQUE"
                ")"
            )
            # The api container does not bind-mount apps/web, but in the test
            # environment we can read the migration file straight from the repo.
            migration = (
                Path(__file__).resolve().parents[2]
                / "web"
                / "db"
                / "migrations"
                / "0007_agents.sql"
            )
            await conn.execute(migration.read_text())
        finally:
            await conn.close()

    asyncio.run(_apply_schema())

    try:
        yield url
    finally:
        pg.stop()


@pytest_asyncio.fixture
async def pg_pool(pg_container: str):
    """Per-test asyncpg pool against the session-scoped testcontainer.

    asyncpg connections are bound to the loop they were created on, so we
    re-create the pool per test (each pytest-asyncio function gets its own
    event loop by default).
    """
    pool = await asyncpg.create_pool(pg_container, min_size=1, max_size=2)
    try:
        yield pool
    finally:
        await pool.close()
