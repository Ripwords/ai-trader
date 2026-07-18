"""Tests for GET /valuation/screen — the watchlist valuation screener.

Contract: bearer-gated; symbols come from the moomoo watchlist (explicit
``symbols`` query param wins when provided, and is the fallback when the
watchlist is unavailable); each symbol runs through the same fetch+value
path as /valuation (snapshots persisted with source='screener'); rows are
ranked by margin of safety descending with nulls last; a per-symbol
failure yields an error row, never aborts the sweep; the symbol list is
capped at 25 with a truncation flag.
"""

from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.deps import get_opend
from app.main import create_app
from app.schemas.watchlist import WatchlistItem
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput

D = Decimal

# Cheap → expensive at the same fundamentals: margin of safety strictly
# decreases with price, so the expected ranking is by ascending price.
_PRICES = {
    "US.NVDA": D("50"),
    "US.AAPL": D("100"),
    "US.TSLA": D("200"),
}


def _fake_fetch(prices: dict[str, Decimal] = _PRICES, boom: set[str] | None = None):
    async def fake(symbol: str) -> ValuationInput:
        if boom and symbol in boom:
            raise RuntimeError(f"yahoo down for {symbol}")
        return ValuationInput(
            symbol=symbol,
            current_price=prices.get(symbol, D("100")),
            fcf_base=D("100"),
            net_debt=D("0"),
            shares_outstanding=D("10"),
            beta=D("1.2"),
            history=[
                HistoryPeriod(period="2024", fcf=D("100")),
                HistoryPeriod(period="2021", fcf=D("80")),
            ],
            metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")),
        )

    return fake


class FakeWatchlistOpend:
    def __init__(self, codes: list[str] | None = None, fail: bool = False):
        self.codes = codes or list(_PRICES)
        self.fail = fail
        self.calls = 0

    def list_watchlist(self, *, group: str = "All") -> list[WatchlistItem]:
        self.calls += 1
        if self.fail:
            raise RuntimeError("opend down")
        return [WatchlistItem(code=c) for c in self.codes]


@pytest.fixture
def screen_client(monkeypatch):
    from app.settings import get_settings

    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    fake_opend = FakeWatchlistOpend()
    app.dependency_overrides[get_opend] = lambda: fake_opend
    c = TestClient(app)
    c.headers.update({"Authorization": "Bearer test-bearer"})
    yield c, fake_opend
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_screen_requires_bearer(monkeypatch):
    from app.settings import get_settings

    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    client = TestClient(create_app())
    r = client.get("/valuation/screen")
    assert r.status_code == 401
    get_settings.cache_clear()


def test_screen_ranks_watchlist_by_margin_of_safety(screen_client, monkeypatch):
    client, fake_opend = screen_client
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", _fake_fetch())

    r = client.get("/valuation/screen")
    assert r.status_code == 200
    body = r.json()
    assert fake_opend.calls == 1
    assert body["truncated"] is False
    assert body["total_symbols"] == 3
    assert [row["symbol"] for row in body["rows"]] == ["US.NVDA", "US.AAPL", "US.TSLA"]
    top = body["rows"][0]
    assert top["fair_value"] is not None
    assert top["current_price"] == "50"
    assert top["data_quality"] == "full"
    assert top["error"] is None


def test_screen_symbol_failure_yields_error_row(screen_client, monkeypatch):
    client, _ = screen_client
    monkeypatch.setattr(
        "app.routers.valuation.fetch_valuation_input",
        _fake_fetch(boom={"US.AAPL"}),
    )

    r = client.get("/valuation/screen")
    assert r.status_code == 200
    rows = r.json()["rows"]
    assert len(rows) == 3
    # Error row sorts last (null margin of safety).
    assert rows[-1]["symbol"] == "US.AAPL"
    assert "yahoo down" in rows[-1]["error"]
    assert rows[-1]["margin_of_safety_pct"] is None


def test_screen_prefers_explicit_symbols_param(screen_client, monkeypatch):
    client, fake_opend = screen_client
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", _fake_fetch())

    r = client.get("/valuation/screen", params={"symbols": "US.TSLA, US.NVDA"})
    assert r.status_code == 200
    body = r.json()
    assert fake_opend.calls == 0  # watchlist untouched when symbols given
    assert {row["symbol"] for row in body["rows"]} == {"US.TSLA", "US.NVDA"}
    assert [row["symbol"] for row in body["rows"]] == ["US.NVDA", "US.TSLA"]


def test_screen_watchlist_failure_degrades_to_empty_with_warning(monkeypatch):
    from app.settings import get_settings

    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    app = create_app()
    app.dependency_overrides[get_opend] = lambda: FakeWatchlistOpend(fail=True)
    client = TestClient(app)
    client.headers.update({"Authorization": "Bearer test-bearer"})
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", _fake_fetch())

    r = client.get("/valuation/screen")
    assert r.status_code == 200
    body = r.json()
    assert body["rows"] == []
    assert any("watchlist unavailable" in w for w in body["warnings"])
    app.dependency_overrides.clear()
    get_settings.cache_clear()


def test_screen_caps_at_25_symbols(screen_client, monkeypatch):
    client, _ = screen_client
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", _fake_fetch())

    symbols = ",".join(f"US.S{i:02d}" for i in range(30))
    r = client.get("/valuation/screen", params={"symbols": symbols})
    assert r.status_code == 200
    body = r.json()
    assert body["total_symbols"] == 30
    assert body["truncated"] is True
    assert len(body["rows"]) == 25
    assert any("truncated" in w for w in body["warnings"])


def test_screen_persists_snapshots_with_screener_source(screen_client, monkeypatch):
    client, _ = screen_client
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", _fake_fetch())

    recorded: list[dict] = []

    async def fake_record(result, *, source, run_id=None) -> bool:
        recorded.append({"symbol": result.symbol, "source": source})
        return True

    monkeypatch.setattr(
        "app.routers.valuation.record_valuation_snapshot", fake_record
    )

    r = client.get("/valuation/screen")
    assert r.status_code == 200
    assert len(recorded) == 3
    assert {c["source"] for c in recorded} == {"screener"}
    assert {c["symbol"] for c in recorded} == set(_PRICES)
