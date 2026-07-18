"""Tests for _compute_run_valuation helper in graph.py.

Verifies fail-soft behaviour (any error → (None, "")) and happy-path
(returns a non-None ValuationResult + a summary containing "Valuation").
"""

from __future__ import annotations

import pytest
from app.services.agents.graph import _compute_run_valuation


@pytest.mark.asyncio
async def test_compute_run_valuation_failsoft(monkeypatch):
    async def boom(symbol):
        raise RuntimeError("down")

    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", boom)
    result, summary = await _compute_run_valuation("AAPL")
    assert result is None
    assert summary == ""


@pytest.mark.asyncio
async def test_compute_run_valuation_returns_summary(monkeypatch):
    from decimal import Decimal as D
    from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

    async def fake(symbol):
        return ValuationInput(
            symbol=symbol,
            current_price=D("100"),
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

    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", fake)
    result, summary = await _compute_run_valuation("AAPL")
    assert result is not None
    assert "Valuation" in summary


def _fake_valuation_input(symbol):
    from decimal import Decimal as D
    from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

    return ValuationInput(
        symbol=symbol,
        current_price=D("100"),
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


@pytest.mark.asyncio
async def test_compute_run_valuation_persists_agent_run_snapshot(monkeypatch):
    async def fake(symbol):
        return _fake_valuation_input(symbol)

    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", fake)

    recorded: list[dict] = []

    async def fake_record(result, *, source, run_id=None) -> bool:
        recorded.append({"symbol": result.symbol, "source": source, "run_id": run_id})
        return True

    monkeypatch.setattr(
        "app.services.agents.graph.record_valuation_snapshot", fake_record
    )

    result, _ = await _compute_run_valuation("AAPL", run_id="run-123")
    assert result is not None
    assert recorded == [{"symbol": "AAPL", "source": "agent_run", "run_id": "run-123"}]


@pytest.mark.asyncio
async def test_compute_run_valuation_no_snapshot_on_failure(monkeypatch):
    async def boom(symbol):
        raise RuntimeError("down")

    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", boom)

    recorded: list[dict] = []

    async def fake_record(result, *, source, run_id=None) -> bool:
        recorded.append({"source": source})
        return True

    monkeypatch.setattr(
        "app.services.agents.graph.record_valuation_snapshot", fake_record
    )

    result, summary = await _compute_run_valuation("AAPL", run_id="run-123")
    assert result is None
    assert recorded == []


@pytest.mark.asyncio
async def test_compute_run_valuation_survives_persist_failure(monkeypatch):
    async def fake(symbol):
        return _fake_valuation_input(symbol)

    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", fake)

    async def bad_record(result, *, source, run_id=None) -> bool:
        raise RuntimeError("must be swallowed by record itself — but even if "
                           "a stub raises, the run must not die")

    monkeypatch.setattr(
        "app.services.agents.graph.record_valuation_snapshot", bad_record
    )

    result, summary = await _compute_run_valuation("AAPL", run_id="run-123")
    assert result is not None
    assert "Valuation" in summary
