"""OpenD being down must not freeze the api.

Two layers: the real SDK context must give up instead of retrying forever,
and a slow OpenD call must not block the event loop that serves every other
route.
"""
import socket
import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager

import pytest
from fastapi.testclient import TestClient

from app.deps import get_opend
from app.main import create_app
from app.services.opend import OpendAdapter
from app.settings import get_settings


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _run_with_deadline(fn, deadline: float):
    box: dict[str, object] = {}

    def target() -> None:
        box["result"] = fn()

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(deadline)
    assert not t.is_alive(), f"call still blocked after {deadline}s"
    return box["result"]


def test_quote_state_returns_unreachable_instead_of_retrying_forever():
    pytest.importorskip("moomoo")
    adapter = OpendAdapter(host="127.0.0.1", port=_closed_port())
    result = _run_with_deadline(adapter.get_global_state, deadline=10)
    assert result["reachable"] is False


def test_trade_context_gives_up_when_opend_is_unreachable():
    pytest.importorskip("moomoo")
    adapter = OpendAdapter(host="127.0.0.1", port=_closed_port())

    def build_and_close() -> bool:
        ctx = adapter._default_trade_ctx_factory()
        ctx.close()
        return True

    assert _run_with_deadline(build_and_close, deadline=10) is True


def test_contexts_have_a_sync_query_connect_timeout():
    pytest.importorskip("moomoo")
    adapter = OpendAdapter(host="127.0.0.1", port=_closed_port())
    for factory in (adapter._default_ctx_factory, adapter._default_trade_ctx_factory):
        ctx = _run_with_deadline(factory, deadline=10)
        try:
            assert ctx._sync_query_connect_timeout is not None
            assert ctx._auto_reconnect is False
        finally:
            ctx.close()


def test_failed_contexts_do_not_leak_threads():
    pytest.importorskip("moomoo")
    adapter = OpendAdapter(host="127.0.0.1", port=_closed_port())
    adapter.get_global_state()
    before = threading.active_count()
    for _ in range(3):
        adapter.get_global_state()
        adapter._default_trade_ctx_factory().close()
    deadline = time.monotonic() + 2
    while threading.active_count() > before and time.monotonic() < deadline:
        time.sleep(0.05)
    assert threading.active_count() <= before


class _BlockingCtx:
    def __init__(self, release: threading.Event, entered: threading.Event) -> None:
        self._release = release
        self._entered = entered

    def get_global_state(self):
        self._entered.set()
        self._release.wait(timeout=10)
        return 0, {"qot_logined": True, "trd_logined": True, "server_ver": "x"}

    def close(self) -> None:
        pass


@asynccontextmanager
async def _no_lifespan(_app) -> AsyncIterator[None]:
    yield


@pytest.fixture
def blocking_client(monkeypatch) -> Iterator[tuple[TestClient, threading.Event, threading.Event]]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    get_settings.cache_clear()
    release = threading.Event()
    entered = threading.Event()
    adapter = OpendAdapter(
        host="127.0.0.1",
        port=1,
        _ctx_factory=lambda: _BlockingCtx(release, entered),
        _trade_ctx_factory=lambda: _BlockingCtx(release, entered),
    )
    app = create_app()
    app.router.lifespan_context = _no_lifespan
    app.dependency_overrides[get_opend] = lambda: adapter
    # Entering the client shares one event loop across requests, which is
    # what production uvicorn does; without it each request gets its own.
    with TestClient(app) as c:
        c.headers.update({"Authorization": "Bearer test-bearer"})
        yield c, release, entered
    release.set()
    get_settings.cache_clear()


def test_blocked_opend_call_does_not_stall_other_routes(blocking_client):
    client, release, entered = blocking_client
    slow = threading.Thread(target=lambda: client.get("/quote/state"), daemon=True)
    slow.start()
    try:
        assert entered.wait(5), "the OpenD call never started"
        started = time.monotonic()
        res = client.get("/health")
        elapsed = time.monotonic() - started
        assert res.status_code == 200
        assert elapsed < 2, f"/health took {elapsed:.1f}s while OpenD was blocked"
    finally:
        release.set()
        slow.join(10)
