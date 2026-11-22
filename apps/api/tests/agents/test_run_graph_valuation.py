"""``_compute_run_valuation`` never fails a run, and always says how it went."""

from __future__ import annotations

from decimal import Decimal as D

import pytest

from app.services.agents.graph import _compute_run_valuation
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput

GRAPH = "app.services.agents.graph"


def _input(symbol: str, fcf: str = "100") -> ValuationInput:
    return ValuationInput(
        symbol=symbol,
        current_price=D("100"),
        fcf_base=D(fcf),
        net_debt=D("0"),
        shares_outstanding=D("10"),
        beta=D("1.2"),
        history=[
            HistoryPeriod(period="2024", fcf=D("100")),
            HistoryPeriod(period="2021", fcf=D("80")),
        ],
        metrics=Metrics(free_cash_flow=D(fcf), shares_outstanding=D("10")),
    )


@pytest.fixture
def recorded(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    rows: list[dict] = []

    async def fake_record(result, *, source, run_id=None) -> bool:
        rows.append({"symbol": result.symbol, "source": source, "run_id": run_id})
        return True

    monkeypatch.setattr(f"{GRAPH}.record_valuation_snapshot", fake_record)
    return rows


def _fetch(monkeypatch: pytest.MonkeyPatch, fcf: str = "100") -> None:
    async def fake(symbol: str) -> ValuationInput:
        return _input(symbol, fcf)

    monkeypatch.setattr(f"{GRAPH}.fetch_valuation_input", fake)


def _fetch_fails(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    async def boom(symbol: str) -> ValuationInput:
        raise error

    monkeypatch.setattr(f"{GRAPH}.fetch_valuation_input", boom)


async def test_a_fetch_error_is_unavailable_with_the_reason(monkeypatch, recorded) -> None:
    _fetch_fails(monkeypatch, RuntimeError("down"))

    outcome = await _compute_run_valuation("AAPL", run_id="run-123")

    assert (outcome.status, outcome.reason, outcome.result) == ("unavailable", "down", None)
    assert "Valuation unavailable for this run: down" in outcome.summary
    assert recorded == []


async def test_an_error_without_a_message_is_named_by_its_type(monkeypatch, recorded) -> None:
    _fetch_fails(monkeypatch, TimeoutError())

    outcome = await _compute_run_valuation("AAPL")

    assert outcome.reason == "TimeoutError"


async def test_a_valid_dcf_is_ok_and_recorded(monkeypatch, recorded) -> None:
    _fetch(monkeypatch)

    outcome = await _compute_run_valuation("AAPL", run_id="run-123")

    assert (outcome.status, outcome.reason) == ("ok", None)
    assert outcome.result is not None
    assert "Fair value/share" in outcome.summary
    assert recorded == [{"symbol": "AAPL", "source": "agent_run", "run_id": "run-123"}]


async def test_a_skipped_dcf_is_multiples_only_with_the_engine_reason(monkeypatch, recorded) -> None:
    _fetch(monkeypatch, fcf="-50")

    outcome = await _compute_run_valuation("AAPL")

    assert outcome.status == "multiples_only"
    assert outcome.result is not None
    assert outcome.reason is not None and outcome.reason.startswith("DCF skipped: non-positive FCF")


async def test_a_discarded_dcf_is_multiples_only_with_the_engine_reason(monkeypatch, recorded) -> None:
    async def fake(symbol: str) -> ValuationInput:
        return _input(symbol).model_copy(update={"current_price": D("100000")})

    monkeypatch.setattr(f"{GRAPH}.fetch_valuation_input", fake)

    outcome = await _compute_run_valuation("AAPL")

    assert outcome.status == "multiples_only"
    assert outcome.result is not None and outcome.result.dcf_invalid_reason
    assert outcome.reason == outcome.result.dcf_invalid_reason
    assert outcome.reason in outcome.summary


async def test_a_failed_snapshot_keeps_the_valuation(monkeypatch) -> None:
    _fetch(monkeypatch)

    async def bad_record(result, *, source, run_id=None) -> bool:
        raise RuntimeError("db down")

    monkeypatch.setattr(f"{GRAPH}.record_valuation_snapshot", bad_record)

    outcome = await _compute_run_valuation("AAPL", run_id="run-123")

    assert outcome.status == "ok"
