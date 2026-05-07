from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.deps import get_opend
from app.main import create_app
from app.settings import get_settings
from tests.test_quote import FakeAdapter


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
