"""Tests for the best-effort valuation_snapshots recorder.

Same contract as the paper_orders ledger: writes go through when the pool
is up, and NOTHING ever raises when it isn't — the valuation response (or
agent run) must be unaffected by snapshot failures.
"""
from decimal import Decimal
import json

import pytest

from app.services.algo import repo as algo_repo
from app.services.valuation import persist
from app.services.valuation.models import ValuationResult, Veto

D = Decimal


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


def _result(**overrides) -> ValuationResult:
    base = dict(
        symbol="US.NVDA",
        current_price=D("100"),
        fair_value=D("150.5"),
        margin_of_safety_pct=D("0.505"),
        scenarios=[],
        assumptions_used=None,
        multiples=None,
        historical_multiples=None,
        reverse_dcf_implied_growth=None,
        data_quality="full",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=[],
    )
    base.update(overrides)
    return ValuationResult(**base)


@pytest.mark.asyncio
async def test_record_valuation_snapshot_inserts_row(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(algo_repo, "_pool", FakePool(conn))
    ok = await persist.record_valuation_snapshot(_result(), source="chat")
    assert ok is True
    assert len(conn.calls) == 1
    query, args = conn.calls[0]
    assert "INSERT INTO valuation_snapshots" in query
    assert args[0] == "US.NVDA"   # symbol
    assert args[1] == "chat"      # source
    assert args[2] is None        # run_id
    assert args[3] == D("150.5")  # fair_value
    assert args[4] == D("100")    # current_price
    assert args[5] == D("0.505")  # margin_of_safety_pct
    assert args[6] == "full"      # data_quality
    assert args[7] is False       # veto_triggered
    assert json.loads(args[8])["symbol"] == "US.NVDA"  # result jsonb


@pytest.mark.asyncio
async def test_record_valuation_snapshot_carries_run_id_and_veto(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(algo_repo, "_pool", FakePool(conn))
    ok = await persist.record_valuation_snapshot(
        _result(
            fair_value=None,
            margin_of_safety_pct=None,
            data_quality="multiples_only",
            veto=Veto(triggered=True, reason="P/S > 30", rating_cap="hold"),
        ),
        source="agent_run",
        run_id="11111111-2222-3333-4444-555555555555",
    )
    assert ok is True
    _query, args = conn.calls[0]
    assert args[1] == "agent_run"
    assert args[2] == "11111111-2222-3333-4444-555555555555"
    assert args[3] is None
    assert args[5] is None
    assert args[6] == "multiples_only"
    assert args[7] is True


@pytest.mark.asyncio
async def test_record_valuation_snapshot_swallows_insert_failure(monkeypatch):
    conn = FakeConn(fail=True)
    monkeypatch.setattr(algo_repo, "_pool", FakePool(conn))
    ok = await persist.record_valuation_snapshot(_result(), source="screener")
    assert ok is False


@pytest.mark.asyncio
async def test_record_valuation_snapshot_swallows_missing_pool(monkeypatch):
    monkeypatch.setattr(algo_repo, "_pool", None)
    ok = await persist.record_valuation_snapshot(_result(), source="chat")
    assert ok is False
