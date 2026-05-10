"""Tests for the LangGraph -> NDJSON event translator.

The fixture mimics our **normalized** chunk shape (see ``run_graph`` in
``app.services.agents.graph``), not raw LangGraph output. ``run_graph`` is the
adapter between TradingAgents' AgentState-snapshot stream and this translator's
input contract: ``{metadata: {langgraph_node, node_finished}, values: {...}}``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.agents.streaming import translate_chunks


@pytest.fixture
def chunks() -> list[dict]:
    p = Path(__file__).parent / "fixtures" / "langgraph_chunks.json"
    return json.loads(p.read_text())


@pytest.mark.asyncio
async def test_translates_to_ndjson_event_taxonomy(chunks: list[dict]) -> None:
    async def gen():
        for c in chunks:
            yield c

    events = [
        e
        async for e in translate_chunks(
            gen(), run_id="r1", symbol="NVDA", config={"x": 1}
        )
    ]
    types = [e["type"] for e in events]
    assert types[0] == "run-start"
    assert "node-start" in types
    assert "tool-call" in types
    assert "tool-result" in types
    assert "node-end" in types
    assert "debate-round" in types
    assert "decision" in types
    decision = next(e for e in events if e["type"] == "decision")
    assert decision["rating"] == "buy"
    assert decision["confidence"] == 72


@pytest.mark.asyncio
async def test_run_start_carries_run_metadata() -> None:
    async def empty():
        if False:
            yield {}

    events = [
        e
        async for e in translate_chunks(
            empty(), run_id="abc", symbol="AAPL", config={"max_debate_rounds": 2}
        )
    ]
    assert len(events) == 1
    assert events[0] == {
        "type": "run-start",
        "run_id": "abc",
        "symbol": "AAPL",
        "config": {"max_debate_rounds": 2},
    }


@pytest.mark.asyncio
async def test_node_start_emitted_once_per_node() -> None:
    async def gen():
        yield {"metadata": {"langgraph_node": "A"}, "values": {}}
        yield {"metadata": {"langgraph_node": "A"}, "values": {}}
        yield {"metadata": {"langgraph_node": "B"}, "values": {}}

    events = [
        e async for e in translate_chunks(gen(), run_id="r", symbol="X", config={})
    ]
    starts = [e for e in events if e["type"] == "node-start"]
    assert [e["node"] for e in starts] == ["A", "B"]


@pytest.mark.asyncio
async def test_tool_result_preview_is_truncated() -> None:
    long_preview = "x" * 1200

    async def gen():
        yield {
            "metadata": {"langgraph_node": "n"},
            "values": {
                "tool_results": [
                    {"name": "t", "ok": True, "preview": long_preview}
                ]
            },
        }

    events = [
        e async for e in translate_chunks(gen(), run_id="r", symbol="X", config={})
    ]
    tr = next(e for e in events if e["type"] == "tool-result")
    assert len(tr["preview"]) == 500
