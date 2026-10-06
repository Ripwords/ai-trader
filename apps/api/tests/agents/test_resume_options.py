"""A resumed run must rebuild the graph with the options it started with."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.messages import AIMessage

from tests.agents.test_router_sync import _FakePool

STORED_CONFIG = {
    "company_name": "NVIDIA Corporation",
    "max_debate_rounds": 2,
    "max_risk_discuss_rounds": 3,
    "deep_thinking": False,
    "reasoning_effort": "high",
    "response_language": "ja-JP",
    "selected_analysts": ["market", "news"],
}


class _RowPool(_FakePool):
    def __init__(self, config: Any) -> None:
        super().__init__()
        self._config = config
        self._conn.fetchrow = self._fetchrow  # type: ignore[attr-defined]

    async def _fetchrow(self, query: str, *args: Any) -> dict[str, Any]:
        return {"symbol": "NVDA", "trade_date": date(2026, 1, 5), "config": self._config}


async def _resume(monkeypatch: pytest.MonkeyPatch, fake_build: Any, config: Any) -> list[dict]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(graph_mod, "build_graph_locked", fake_build)
    app = create_app()
    app.state.pg_pool = _RowPool(config)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run/run-1/resume", headers={"authorization": "Bearer test-bearer"},
        ) as r:
            assert r.status_code == 200
            return [json.loads(line) async for line in r.aiter_lines() if line.strip()]


# What the run had checkpointed before it halted: two analyst reports done.
CHECKPOINT = {
    "company_of_interest": "NVDA",
    "trade_date": "2026-01-05",
    "messages": [],
    "market_report": "market says up",
    "news_report": "news is mixed",
}


class _Snapshot:
    def __init__(self, values: dict[str, Any]) -> None:
        self.values = values


class _Propagator:
    def get_graph_args(self) -> dict[str, Any]:
        return {"stream_mode": "values", "config": {"recursion_limit": 77}}


class _Compiled:
    """Mimics LangGraph resume: raw AgentState snapshots, starting with the
    checkpoint itself, then one per superstep."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, dict[str, Any]]] = []

    async def aget_state(self, config: dict[str, Any]) -> _Snapshot:
        return _Snapshot(dict(CHECKPOINT))

    async def astream(self, input: Any, **kw: Any):
        self.calls.append((input, kw))
        yield dict(CHECKPOINT)
        state = {**CHECKPOINT, "fundamentals_report": "fundamentals are fine"}
        yield state
        yield {**state, "final_trade_decision": "FINAL TRANSACTION PROPOSAL: **SELL**"}


class _JudgeLlm:
    async def ainvoke(self, _prompt: str, config: Any = None) -> AIMessage:
        return AIMessage(content="CONFIDENCE: 66\nREASON: resumed")


class _Graph:
    def __init__(self) -> None:
        self.graph = _Compiled()
        self.propagator = _Propagator()
        self.deep_thinking_llm = _JudgeLlm()


@pytest.fixture(autouse=True)
def _no_valuation(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.agents import graph as graph_mod

    async def fake_valuation(*_a: Any, **_kw: Any) -> tuple[None, str]:
        return None, ""

    monkeypatch.setattr(graph_mod, "_compute_run_valuation", fake_valuation)


@pytest.mark.asyncio
async def test_resume_streams_the_same_shape_as_a_normal_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built = _Graph()

    async def fake_build(_opend: Any, **_kw: Any) -> _Graph:
        return built

    lines = await _resume(monkeypatch, fake_build, STORED_CONFIG)
    types = [e["type"] for e in lines]

    [(input_, kw)] = built.graph.calls
    assert input_ is None
    assert kw["stream_mode"] == "values"
    assert kw["config"]["configurable"]["thread_id"] == "run-1"
    assert kw["config"]["recursion_limit"] == 77

    decision = next(e for e in lines if e["type"] == "decision")
    assert decision["rating"] == "sell"
    assert decision["confidence"] == 66
    reports = [e for e in lines if e["type"] == "report"]
    # Only what the resume produced; the checkpointed reports were already streamed.
    assert [r["kind"] for r in reports] == ["fundamentals"]
    final = next(e for e in lines if e["type"] == "final-state")
    assert final["state"]["market_report"] == "market says up"
    assert final["state"]["final_trade_decision"].endswith("**SELL**")
    assert "run-start" not in types
    assert types[-1] == "run-end"


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", [STORED_CONFIG, json.dumps(STORED_CONFIG)])
async def test_resume_rebuilds_the_graph_with_stored_options(
    monkeypatch: pytest.MonkeyPatch, stored: Any
) -> None:
    seen: dict[str, Any] = {}

    async def fake_build(_opend: Any, **kwargs: Any) -> _Graph:
        seen.update(kwargs)
        return _Graph()

    lines = await _resume(monkeypatch, fake_build, stored)

    assert {k: seen[k] for k in STORED_CONFIG} == STORED_CONFIG
    assert lines[-1]["type"] == "run-end"


@pytest.mark.asyncio
async def test_resume_graph_build_failure_ends_with_error_and_run_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_build(*_a: Any, **_kw: Any) -> _Graph:
        raise RuntimeError("no provider configured")

    lines = await _resume(monkeypatch, fake_build, {})

    assert [e["type"] for e in lines] == ["error", "run-end"]
    assert "no provider configured" in lines[0]["message"]
