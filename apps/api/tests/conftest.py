import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    from app.settings import get_settings
    get_settings.cache_clear()
    return TestClient(create_app())


@pytest.fixture
def client_with_bearer(monkeypatch) -> TestClient:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.settings import get_settings
    get_settings.cache_clear()
    c = TestClient(create_app())
    c.headers.update({"Authorization": "Bearer test-bearer"})
    return c
