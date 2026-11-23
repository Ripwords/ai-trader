"""The analysts fan out, the debate waits for all of them, and the stream
still names the right agent on every event.

These run the real compiled graph. Only the chat models, the tools and the
valuation fetch are faked, and the fakes sleep so wall-clock shows whether
steps overlapped.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from app.services.agents import graph as graph_mod
from app.services.agents import llm_config
from app.services.agents.graph import ValuationOutcome
from app.services.agents.llm_config import LlmRuntimeConfig, RoleModel
from app.services.agents.streaming import translate_chunks

LLM_DELAY_S = 0.25
ANALYSTS = ("market", "social", "news", "fundamentals")
LABELS = {
    "market": "Market Analyst",
    "social": "Social Analyst",
    "news": "News Analyst",
    "fundamentals": "Fundamentals Analyst",
}
TOOL_NAMES = (
    "get_stock_data", "get_indicators", "get_fundamentals", "get_balance_sheet",
    "get_cashflow", "get_income_statement", "get_insider_transactions", "get_news",
    "get_global_news", "get_earnings_release", "get_earnings_surprise",
    "get_earnings_call_transcript", "get_estimate_revisions",
)
VALUATION_MARKER = "VALUATIONMARKER intrinsic value 123"
DAY = date(2026, 1, 5)


def _role_of(tool_names: set[str]) -> str:
    if "get_stock_data" in tool_names:
        return "market"
    if "get_fundamentals" in tool_names:
        return "fundamentals"
    if "get_global_news" in tool_names:
        return "news"
    return "social"


class FakeLlm:
    """Every analyst calls its first tool once, then writes ``<role> report``.
    Each call sleeps, on the worker thread LangGraph gives a sync node."""

    def __init__(self, delay: float = LLM_DELAY_S, fail_once: str | None = None) -> None:
        self.delay = delay
        self.fail_once = fail_once
        self._lock = threading.Lock()
        self.analyst_inputs: dict[str, list[list[Any]]] = {a: [] for a in ANALYSTS}
        self.prompts: list[str] = []
        self.judge_prompts: list[str] = []
        self.fail_on_prompt: int | None = None

    def bind_tools(self, tools: list[Any]) -> Any:
        names = [t.name for t in tools]
        role = _role_of(set(names))

        def answer(prompt_value: Any) -> AIMessage:
            messages = prompt_value.to_messages()
            with self._lock:
                self.analyst_inputs[role].append(messages)
            time.sleep(self.delay)
            if not any(isinstance(m, ToolMessage) for m in messages):
                call = {"name": names[0], "args": {"ticker": role}, "id": f"{role}-1"}
                return AIMessage(content="", tool_calls=[call])
            if self.fail_once == role:
                self.fail_once = None
                # The step's other analysts all slept the same delay; let them
                # save their reports before this one halts the step.
                time.sleep(4 * self.delay)
                raise RuntimeError(f"{role} provider outage")
            return AIMessage(content=f"{role} report")

        return RunnableLambda(answer)

    def invoke(self, prompt: Any) -> AIMessage:
        with self._lock:
            self.prompts.append(str(prompt))
            if self.fail_on_prompt == len(self.prompts):
                self.fail_on_prompt = None
                self.prompts.pop()
                raise RuntimeError("debate provider outage")
        time.sleep(self.delay)
        return AIMessage(content="Argument. FINAL TRANSACTION PROPOSAL: **BUY**")

    async def ainvoke(self, prompt: str, config: Any = None) -> AIMessage:
        self.judge_prompts.append(prompt)
        return AIMessage(content="CONFIDENCE: 70\nREASON: fake")


def _fake_toolkit() -> SimpleNamespace:
    def make(name: str) -> Any:
        @tool(name)
        def fake(ticker: str) -> str:
            """Fake data tool."""
            return f"{name} data for {ticker}"

        return fake

    return SimpleNamespace(**{name: make(name) for name in TOOL_NAMES})


def _role(kind: str) -> RoleModel:
    return RoleModel.model_validate(
        {"kind": kind, "model_id": "m-1", "api_key": "sk-test", "base_url": None}
    )


@pytest.fixture
def llm(monkeypatch: pytest.MonkeyPatch) -> FakeLlm:
    fake = FakeLlm()
    monkeypatch.setattr(llm_config, "build_role_model", lambda *_a, **_kw: fake)
    monkeypatch.setattr(graph_mod, "build_toolkit", lambda *_a, **_kw: _fake_toolkit())
    return fake


@pytest.fixture
def valuation_delay(monkeypatch: pytest.MonkeyPatch) -> dict[str, float]:
    delay = {"seconds": 0.0}

    async def fake_valuation(*_a: Any, **_kw: Any) -> ValuationOutcome:
        await asyncio.sleep(delay["seconds"])
        return ValuationOutcome("ok", None, None, VALUATION_MARKER)

    monkeypatch.setattr(graph_mod, "_compute_run_valuation", fake_valuation)
    return delay


def _build(tmp_path: Any, **kw: Any) -> Any:
    models = LlmRuntimeConfig(chat=_role("anthropic"), quick=_role("anthropic"))
    return graph_mod.build_graph(None, models=models, results_dir=tmp_path, **kw)


async def _events(chunks: Any) -> list[dict]:
    return [e async for e in translate_chunks(chunks, run_id="r", symbol="NVDA", config={})]


async def _run(graph: Any, run_id: str | None = None) -> tuple[list[dict], float]:
    """The run's events, and the seconds until the last analyst report."""
    start = time.perf_counter()
    reports_done = 0.0
    events: list[dict] = []
    chunks = graph_mod.run_graph(graph, "NVDA", DAY, 1, True, run_id=run_id)
    async for event in translate_chunks(chunks, run_id="r", symbol="NVDA", config={}):
        events.append(event)
        if event["type"] == "report":
            reports_done = time.perf_counter() - start
    return events, reports_done


async def test_four_analysts_finish_in_the_time_of_one(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, reports_done = await _run(_build(tmp_path))

    assert len([e for e in events if e["type"] == "report"]) == 4
    one_analyst = 2 * LLM_DELAY_S
    print(f"\nanalyst phase: {reports_done:.2f}s (one analyst alone: {one_analyst:.2f}s)")
    assert reports_done < 2 * one_analyst


async def test_each_analyst_sees_only_its_own_tool_loop(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path))

    for role in ANALYSTS:
        first, second = llm.analyst_inputs[role]
        assert [m.type for m in first] == ["system", "human"]
        assert [m.type for m in second] == ["system", "human", "ai", "tool"]
        assert second[2].tool_calls[0]["id"] == f"{role}-1"
        assert second[3].tool_call_id == f"{role}-1"


async def test_stream_names_the_analyst_that_made_each_tool_call(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    calls = [e for e in events if e["type"] == "tool-call"]
    results = [e for e in events if e["type"] == "tool-result"]
    assert sorted(e["node"] for e in calls) == sorted(LABELS.values())
    assert sorted(e["node"] for e in results) == sorted(LABELS.values())
    # The social and news analysts both call get_news; the args say whose call it was.
    for e in calls:
        assert e["node"] == LABELS[e["args"]["ticker"]]
    for e in results:
        assert e["preview"].endswith(next(r for r, label in LABELS.items() if label == e["node"]))

    reports = {e["node"]: e["content"] for e in events if e["type"] == "report"}
    assert reports == {label: f"{role} report" for role, label in LABELS.items()}


async def test_every_analyst_starts_before_any_finishes_and_each_ends_once(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    types = [(e["type"], e.get("node")) for e in events]
    first_end = next(i for i, t in enumerate(types) if t[0] == "node-end")
    started = [node for kind, node in types[:first_end] if kind == "node-start"]
    assert started == list(LABELS.values())
    ended = [node for kind, node in types if kind == "node-end" and node in LABELS.values()]
    assert sorted(ended) == sorted(LABELS.values())


async def test_every_started_node_ends(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    started = [e["node"] for e in events if e["type"] == "node-start"]
    ended = [e["node"] for e in events if e["type"] == "node-end"]
    assert started[4:] == [
        "Bull Researcher", "Bear Researcher", "Research Manager", "Trader",
        "Aggressive Analyst", "Conservative Analyst", "Neutral Analyst", "Risk Manager",
    ]
    assert sorted(ended) == sorted(started)
    assert ended[4:] == started[4:]


async def test_debate_starts_only_after_every_report_is_in(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path))

    # Bull, bear, research manager, trader, three risk debaters, risk judge.
    assert len(llm.prompts) == 8
    for prompt in llm.prompts:
        for role in ANALYSTS:
            assert f"{role} report" in prompt


async def test_only_selected_analysts_run(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path, selected_analysts=["news", "market"]))

    assert sorted(e["kind"] for e in events if e["type"] == "report") == ["market", "news"]
    assert llm.analyst_inputs["social"] == []
    assert llm.analyst_inputs["fundamentals"] == []
    assert next(e for e in events if e["type"] == "decision")["rating"] == "buy"


async def test_result_shape_is_unchanged(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    decision = next(e for e in events if e["type"] == "decision")
    assert decision["rating"] == "buy"
    assert decision["confidence"] == 70
    # The Research Manager's judge decision is the same text as its plan, so
    # it is not streamed as a second card.
    assert [e["stage"] for e in events if e["type"] == "synthesis"] == [
        "investment-plan", "trader-plan",
    ]
    final = next(e for e in events if e["type"] == "final-state")["state"]
    assert set(final) == {
        "market_report", "sentiment_report", "news_report", "fundamentals_report",
        "investment_plan", "trader_investment_plan", "final_trade_decision",
        "investment_debate_state", "risk_debate_state", "valuation",
    }
    assert final["valuation"] == {"status": "ok", "reason": None}
    assert final["sentiment_report"] == "social report"
    assert not any(key.endswith("_messages") for key in final)


async def test_valuation_overlaps_the_analysts_and_reaches_every_debate_prompt(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    # Still running when the Bull Researcher's turn comes (the analysts take
    # about 2 LLM delays), so only a gate gets it into the first argument.
    valuation_delay["seconds"] = 4 * LLM_DELAY_S
    graph = _build(tmp_path)

    events, reports_done = await _run(graph)

    assert len(llm.prompts) == 8
    for prompt in llm.prompts:
        assert prompt.count(VALUATION_MARKER) == 1
    # The reports did not wait for the valuation.
    assert reports_done < valuation_delay["seconds"]
    types = [e["type"] for e in events]
    assert types.count("valuation") == 1
    assert types.index("valuation") < types.index("debate-round")
    assert next(e for e in events if e["type"] == "valuation") == {
        "type": "valuation", "status": "ok", "reason": None,
    }


async def test_a_failed_valuation_is_said_to_the_debate_and_the_stream(
    llm: FakeLlm, monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    async def boom(_symbol: str) -> None:
        raise RuntimeError("yahoo timed out")

    monkeypatch.setattr(graph_mod, "fetch_valuation_input", boom)

    events, _ = await _run(_build(tmp_path))

    unavailable = {"status": "unavailable", "reason": "yahoo timed out"}
    assert next(e for e in events if e["type"] == "valuation") == {"type": "valuation", **unavailable}
    assert next(e for e in events if e["type"] == "final-state")["state"]["valuation"] == unavailable
    for prompt in llm.prompts:
        assert "Valuation unavailable for this run: yahoo timed out" in prompt
    assert next(e for e in events if e["type"] == "decision")["rating"] == "buy"


async def test_resume_after_one_analyst_fails_reruns_only_that_analyst(
    monkeypatch: pytest.MonkeyPatch, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    fake = FakeLlm(delay=0.05, fail_once="news")
    monkeypatch.setattr(llm_config, "build_role_model", lambda *_a, **_kw: fake)
    monkeypatch.setattr(graph_mod, "build_toolkit", lambda *_a, **_kw: _fake_toolkit())
    saver = InMemorySaver()

    with pytest.raises(RuntimeError, match="news provider outage"):
        await _run(_build(tmp_path, checkpointer=saver), run_id="run-1")
    calls_before = {role: len(inputs) for role, inputs in fake.analyst_inputs.items()}

    # A resume builds a new graph on the same saver, as the router does.
    resumed = _build(tmp_path, checkpointer=saver)
    events = await _events(graph_mod.resume_graph(resumed, "NVDA", DAY, run_id="run-1"))

    for role in ("market", "social", "fundamentals"):
        assert len(fake.analyst_inputs[role]) == calls_before[role] == 2
    assert len(fake.analyst_inputs["news"]) == calls_before["news"] + 1
    # The halted step never reached the stream, so the three reports saved
    # from it are streamed now, next to the one that had to be redone.
    assert sorted(e["kind"] for e in events if e["type"] == "report") == [
        "fundamentals", "market", "news", "sentiment",
    ]
    final = next(e for e in events if e["type"] == "final-state")["state"]
    for role, field in (
        ("market", "market_report"), ("social", "sentiment_report"),
        ("news", "news_report"), ("fundamentals", "fundamentals_report"),
    ):
        assert final[field] == f"{role} report"
    assert next(e for e in events if e["type"] == "decision")["rating"] == "buy"
    assert len([p for p in fake.prompts if VALUATION_MARKER in p]) == 8
    assert [e["type"] for e in events].count("valuation") == 1


REPLY = "Argument. FINAL TRANSACTION PROPOSAL: **BUY**"
DEBATE_ROUNDS = [(1, "bull", f"Bull Analyst: {REPLY}"), (1, "bear", f"Bear Analyst: {REPLY}")]
RISK_TURNS = [
    (1, "aggressive", f"Aggressive Analyst: {REPLY}"),
    (2, "conservative", f"Conservative Analyst: {REPLY}"),
    (3, "neutral", f"Neutral Analyst: {REPLY}"),
]


def _debate_rounds(events: list[dict]) -> list[tuple]:
    return [(e["round"], e["side"], e["text"]) for e in events if e["type"] == "debate-round"]


def _risk_turns(events: list[dict]) -> list[tuple]:
    return [(e["turn"], e["speaker"], e["text"]) for e in events if e["type"] == "risk-debate-turn"]


async def test_stream_carries_every_debate_turn_with_its_speaker(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    assert _debate_rounds(events) == DEBATE_ROUNDS
    assert _risk_turns(events) == RISK_TURNS


async def test_final_state_keeps_both_debate_transcripts(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    events, _ = await _run(_build(tmp_path))

    final = next(e for e in events if e["type"] == "final-state")["state"]
    assert final["investment_debate_state"] == {
        "bull_history": f"\nBull Analyst: {REPLY}",
        "bear_history": f"\nBear Analyst: {REPLY}",
        "judge_decision": REPLY,
    }
    assert final["risk_debate_state"] == {
        "aggressive_history": f"\nAggressive Analyst: {REPLY}",
        "conservative_history": f"\nConservative Analyst: {REPLY}",
        "neutral_history": f"\nNeutral Analyst: {REPLY}",
        "judge_decision": REPLY,
    }
    json.dumps(final)


async def test_confidence_judge_reads_the_whole_debate(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path))

    (prompt,) = llm.judge_prompts
    for speaker in ("Bull", "Bear", "Aggressive", "Conservative", "Neutral"):
        assert f"{speaker} Analyst: {REPLY}" in prompt


async def test_resume_mid_debate_streams_only_the_turns_still_to_come(
    monkeypatch: pytest.MonkeyPatch, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    fake = FakeLlm(delay=0.05)
    # Bull, bear, research manager, trader and the aggressive analyst answer;
    # the conservative analyst's call fails.
    fake.fail_on_prompt = 6
    monkeypatch.setattr(llm_config, "build_role_model", lambda *_a, **_kw: fake)
    monkeypatch.setattr(graph_mod, "build_toolkit", lambda *_a, **_kw: _fake_toolkit())
    saver = InMemorySaver()

    with pytest.raises(RuntimeError, match="debate provider outage"):
        await _run(_build(tmp_path, checkpointer=saver), run_id="run-2")

    resumed = _build(tmp_path, checkpointer=saver)
    events = await _events(graph_mod.resume_graph(resumed, "NVDA", DAY, run_id="run-2"))

    assert _debate_rounds(events) == []
    assert _risk_turns(events) == RISK_TURNS[1:]
    final = next(e for e in events if e["type"] == "final-state")["state"]
    assert final["investment_debate_state"]["bull_history"] == f"\nBull Analyst: {REPLY}"
    assert final["risk_debate_state"]["aggressive_history"] == f"\nAggressive Analyst: {REPLY}"


def test_debate_wiring_matches_upstream(llm: FakeLlm, tmp_path: Any) -> None:
    """Ours replaces only the analyst stage. If upstream rewires the debate,
    this fails and the copy in ``graph.py`` needs the same change."""
    from tradingagents.graph.conditional_logic import ConditionalLogic
    from tradingagents.graph.setup import GraphSetup, MemoryComponents

    ta = _build(tmp_path)
    upstream = GraphSetup(
        quick_thinking_llm=llm,
        deep_thinking_llm=llm,
        tool_nodes=ta.tool_nodes,
        memories=MemoryComponents(
            bull=ta.bull_memory, bear=ta.bear_memory, trader=ta.trader_memory,
            invest_judge=ta.invest_judge_memory, risk_manager=ta.risk_manager_memory,
        ),
        conditional_logic=ConditionalLogic(),
    ).setup_graph()

    def debate_edges(compiled: Any) -> set[tuple[str, str, bool]]:
        stage = {
            "Bull Researcher", "Bear Researcher", "Research Manager", "Trader",
            "Aggressive Analyst", "Conservative Analyst", "Neutral Analyst",
            "Risk Judge", "__end__",
        }
        return {
            (e.source, e.target, e.conditional)
            for e in compiled.get_graph().edges
            if e.source in stage and e.target in stage
        }

    assert debate_edges(ta.graph) == debate_edges(upstream)
    assert debate_edges(upstream)
