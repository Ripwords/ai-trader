from fastapi.testclient import TestClient


def test_protected_route_rejects_missing_bearer(client: TestClient):
    res = client.get("/_internal/whoami")
    assert res.status_code == 401


def test_protected_route_rejects_wrong_bearer(client: TestClient):
    res = client.get("/_internal/whoami", headers={"Authorization": "Bearer nope"})
    assert res.status_code == 401


def test_protected_route_accepts_correct_bearer(client_with_bearer: TestClient):
    res = client_with_bearer.get("/_internal/whoami")
    assert res.status_code == 200
    assert res.json() == {"caller": "internal"}
