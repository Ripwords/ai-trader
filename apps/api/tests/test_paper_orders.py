"""Tests for the best-effort paper_orders ledger recorder.

The recorder sits on the critical path of live order placement, so the
contract under test is: writes go through when the pool is up, and NOTHING
ever raises when it isn't — the order must not be affected.
"""
import json

import pytest

from app.services import paper_orders
from app.services.algo import repo as algo_repo


class FakeConn:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls: list[tuple] = []

    async def execute(self, query, *args):
        if self.fail:
            raise RuntimeError("db down")
        self.calls.append((query, args))
        return "INSERT 0 1"


class FakeAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class FakePool:
    def __init__(self, conn):
        self._conn = conn

    def acquire(self):
        return FakeAcquire(self._conn)


@pytest.mark.asyncio
async def test_record_paper_order_inserts_row(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(algo_repo, "_pool", FakePool(conn))
    ok = await paper_orders.record_paper_order(
        source="algo",
        symbol="US.NVDA",
        side="BUY",
        qty=5,
        moomoo_order_id="ord-1",
        acc_id="123",
        price=100.5,
        order_type="MARKET",
        trd_env="SIMULATE",
        status="SUBMITTED",
        raw={"order_id": "ord-1"},
    )
    assert ok is True
    assert len(conn.calls) == 1
    query, args = conn.calls[0]
    assert "INSERT INTO paper_orders" in query
    assert args[0] == "algo"
    assert args[1] is None  # decision_id
    assert args[2] == "ord-1"
    assert args[4] == "US.NVDA"
    assert args[5] == "BUY"
    assert args[6] == 5
    assert json.loads(args[11]) == {"order_id": "ord-1"}


@pytest.mark.asyncio
async def test_record_paper_order_swallows_insert_failure(monkeypatch):
    conn = FakeConn(fail=True)
    monkeypatch.setattr(algo_repo, "_pool", FakePool(conn))
    ok = await paper_orders.record_paper_order(
        source="chat", symbol="US.AAPL", side="SELL", qty=1
    )
    assert ok is False


@pytest.mark.asyncio
async def test_record_paper_order_swallows_missing_pool(monkeypatch):
    monkeypatch.setattr(algo_repo, "_pool", None)
    ok = await paper_orders.record_paper_order(
        source="agent_decision", symbol="US.AAPL", side="BUY", qty=1
    )
    assert ok is False
