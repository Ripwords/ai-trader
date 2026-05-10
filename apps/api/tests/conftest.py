import os
from collections.abc import Iterator

import pytest
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
