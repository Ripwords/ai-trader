import pytest
from unittest.mock import patch

from app.services.agents.toolkit import resolve_company_name, resolve_symbol


def _resp(payload):
    class R:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return payload

    return R()


@pytest.mark.asyncio
async def test_resolve_symbol_returns_full_verdict(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        return _resp({"status": "resolved", "moomoo": "US.MU", "name": "Micron Technology, Inc."})

    with patch("httpx.AsyncClient.get", new=fake_get):
        r = await resolve_symbol("MU")

    assert r["status"] == "resolved"
    assert r["moomoo"] == "US.MU"


@pytest.mark.asyncio
async def test_resolve_symbol_returns_error_status_on_outage(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        raise RuntimeError("connection refused")

    with patch("httpx.AsyncClient.get", new=fake_get):
        assert (await resolve_symbol("US.MU"))["status"] == "error"


@pytest.mark.asyncio
async def test_resolve_company_name_returns_name_when_resolved(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    captured = {}

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        captured["url"] = url
        captured["params"] = params
        return _resp({"status": "resolved", "moomoo": "US.MU", "name": "Micron Technology, Inc."})

    with patch("httpx.AsyncClient.get", new=fake_get):
        name = await resolve_company_name("US.MU")

    assert name == "Micron Technology, Inc."
    assert "/api/internal/symbol/resolve" in captured["url"]
    assert captured["params"] == {"q": "US.MU"}


@pytest.mark.asyncio
async def test_resolve_company_name_returns_none_when_not_resolved(monkeypatch):
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        return _resp({"status": "ambiguous", "candidates": []})

    with patch("httpx.AsyncClient.get", new=fake_get):
        assert await resolve_company_name("MU") is None


@pytest.mark.asyncio
async def test_resolve_company_name_swallows_errors(monkeypatch):
    """A resolver outage must not crash the run — the toolkit still works
    ticker-only; we just lose the name anchor."""
    monkeypatch.setenv("WEB_INTERNAL_BASE_URL", "http://web:3000")
    monkeypatch.setenv("INTERNAL_BEARER", "secret")

    async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
        raise RuntimeError("connection refused")

    with patch("httpx.AsyncClient.get", new=fake_get):
        assert await resolve_company_name("US.MU") is None
