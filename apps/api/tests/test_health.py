from fastapi.testclient import TestClient


def test_health_returns_ok(client: TestClient):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
