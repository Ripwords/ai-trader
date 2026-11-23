"""Every node says it started when it starts, says it ended with a short
summary of what it wrote, and a resumed run names only the nodes it reruns.
These run the real compiled graph."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.services.agents import graph as graph_mod
from app.services.agents import llm_config
from app.services.agents.graph import _summary
from app.services.agents.streaming import translate_chunks
from tests.agents.test_parallel_analysts import (  # noqa: F401 - llm and valuation_delay are fixtures
    DAY,
    LABELS,
    FakeLlm,
    _build,
    _events,
    _fake_toolkit,
    _run,
    llm,
    valuation_delay,
)

DEBATE = [
    "Bull Researcher",
    "Bear Researcher",
    "Research Manager",
    "Trader",
    "Aggressive Analyst",
    "Conservative Analyst",
    "Neutral Analyst",
    "Risk Manager",
]
SPOKEN = "Argument. FINAL TRANSACTION PROPOSAL: BUY"


def _nodes(events: list[dict], kind: str) -> list[str]:
    return [e["node"] for e in events if e["type"] == kind]


class WatchingLlm(FakeLlm):
    """Notes which node the stream last announced at the moment each debate
    call returns."""

    def __init__(self, stream: list[dict]) -> None:
        super().__init__()
        self.stream = stream
        self.running_when_answered: list[str | None] = []

    def invoke(self, prompt: Any) -> AIMessage:
        reply = super().invoke(prompt)
        started = _nodes(list(self.stream), "node-start")
        self.running_when_answered.append(started[-1] if started else None)
        return reply


async def test_each_debate_node_is_announced_while_its_model_is_still_working(
    monkeypatch: pytest.MonkeyPatch, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    stream: list[dict] = []
    fake = WatchingLlm(stream)
    monkeypatch.setattr(llm_config, "build_role_model", lambda *_a, **_kw: fake)
    monkeypatch.setattr(graph_mod, "build_toolkit", lambda *_a, **_kw: _fake_toolkit())

    chunks = graph_mod.run_graph(_build(tmp_path), "NVDA", DAY, 1, True)
    async for event in translate_chunks(chunks, run_id="r", symbol="NVDA", config={}):
        stream.append(event)

    assert fake.running_when_answered == DEBATE


async def test_every_debate_node_starts_and_ends_in_turn(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    turns = [
        (e["type"], e["node"])
        for e in events
        if e["type"] in ("node-start", "node-end") and e["node"] in DEBATE
    ]
    assert turns == [pair for node in DEBATE for pair in (("node-start", node), ("node-end", node))]


async def test_a_debater_who_speaks_twice_starts_and_ends_twice(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path, max_debate_rounds=2))

    for kind in ("node-start", "node-end"):
        assert [n for n in _nodes(events, kind) if n in DEBATE[:3]] == [
            "Bull Researcher", "Bear Researcher", "Bull Researcher", "Bear Researcher",
            "Research Manager",
        ]


async def test_every_node_end_carries_a_short_summary_of_what_the_node_wrote(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    summaries = {e["node"]: e["summary"] for e in events if e["type"] == "node-end"}
    assert summaries == {
        **{label: f"{role} report" for role, label in LABELS.items()},
        **{node: SPOKEN for node in DEBATE},
    }


async def test_a_resumed_run_announces_only_the_nodes_it_reruns(
    monkeypatch: pytest.MonkeyPatch, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    fake = FakeLlm(delay=0.05)
    fake.fail_on_prompt = 6
    monkeypatch.setattr(llm_config, "build_role_model", lambda *_a, **_kw: fake)
    monkeypatch.setattr(graph_mod, "build_toolkit", lambda *_a, **_kw: _fake_toolkit())
    saver = InMemorySaver()

    with pytest.raises(RuntimeError, match="debate provider outage"):
        await _run(_build(tmp_path, checkpointer=saver), run_id="run-3")

    resumed = _build(tmp_path, checkpointer=saver)
    events = await _events(graph_mod.resume_graph(resumed, "NVDA", DAY, run_id="run-3"))

    assert _nodes(events, "node-start") == DEBATE[5:]
    assert _nodes(events, "node-end") == DEBATE[5:]


@pytest.mark.parametrize(
    ("text", "summary"),
    [
        ("", ""),
        ("Bull Analyst: Margins are **widening** fast.\nMore.", "Margins are widening fast."),
        ("# Market report\n\n---\n| a | b |\n\nPrice is `above` the 50-day.", "Price is above the 50-day."),
        ("## Only a heading", "Only a heading"),
        ("- First point of a list", "First point of a list"),
        ("word " * 100, ("word " * 40)[:199].rstrip() + "…"),
    ],
)
def test_summary_is_the_first_line_of_prose_without_markup(text: str, summary: str) -> None:
    assert _summary(text) == summary
    assert len(_summary(text)) <= 200
