from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import get_settings


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    get_settings.cache_clear()
    yield TestClient(create_app())
    get_settings.cache_clear()


@pytest.fixture
def client_with_bearer(monkeypatch) -> Generator[TestClient, None, None]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    c = TestClient(create_app())
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c
    get_settings.cache_clear()
