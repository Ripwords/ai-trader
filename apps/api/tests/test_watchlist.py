from app.schemas.watchlist import WatchlistItem


class FakeAdapter:
    def __init__(self):
        self.added: list[tuple[str, str]] = []
        self.removed: list[tuple[str, str]] = []

    def list_watchlist(self, *, group="All"):
        return [WatchlistItem(code="US.NVDA", name="NVIDIA", group=group)]

    def add_watchlist_item(self, code, *, group="All"):
        self.added.append((code, group))

    def remove_watchlist_item(self, code, *, group="All"):
        self.removed.append((code, group))


def test_list_returns_items(client_with_bearer_and_fake_watchlist):
    res = client_with_bearer_and_fake_watchlist.get("/watchlist/list")
    assert res.status_code == 200
    body = res.json()
    assert body[0]["code"] == "US.NVDA"


def test_add_calls_adapter(client_with_bearer_and_fake_watchlist, fake_watchlist_adapter):
    res = client_with_bearer_and_fake_watchlist.post(
        "/watchlist/add", json={"code": "US.AAPL", "group": "All"}
    )
    assert res.status_code == 200
    assert fake_watchlist_adapter.added == [("US.AAPL", "All")]


def test_remove_calls_adapter(client_with_bearer_and_fake_watchlist, fake_watchlist_adapter):
    res = client_with_bearer_and_fake_watchlist.post(
        "/watchlist/remove", json={"code": "US.AAPL", "group": "All"}
    )
    assert res.status_code == 200
    assert fake_watchlist_adapter.removed == [("US.AAPL", "All")]


def test_unauth_returns_401(client):
    res = client.get("/watchlist/list")
    assert res.status_code == 401
