"""Editable debate prompts: defaults, per-run overrides, and the patched loader."""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
import threading
from typing import Any, TypedDict

import httpx
import pytest
from langgraph.graph import END, START, StateGraph
from tradingagents.agents import prompts as ta_prompts

from app.services.agents import confidence
from app.services.agents import prompts as prompts_mod
from app.settings import get_settings


NODE_NAMES = (
    "market_analyst",
    "social_media_analyst",
    "news_analyst",
    "fundamentals_analyst",
    "bull_researcher",
    "bear_researcher",
    "research_manager",
    "trader_system",
    "trader_user",
    "aggressive_debator",
    "conservative_debator",
    "neutral_debator",
    "risk_manager",
)


def _raw(name: str) -> str:
    return (ta_prompts._PROMPT_DIR / f"{name}.md").read_text()


def _serve(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(prompts_mod, "_transport", httpx.MockTransport(wrapped))
    return seen


# --- defaults -----------------------------------------------------------------


def test_defaults_cover_every_node_prompt_and_the_judge() -> None:
    defaults = prompts_mod.prompt_defaults()
    assert set(defaults) == {*NODE_NAMES, "confidence_judge"}
    for name in NODE_NAMES:
        assert defaults[name]["text"] == _raw(name)
        assert "Please respond in" not in defaults[name]["text"]
    assert defaults["market_analyst"]["placeholders"] == ["current_date", "ticker", "tool_names"]
    assert defaults["trader_system"]["placeholders"] == ["past_memory_str"]
    assert defaults["confidence_judge"]["placeholders"] == ["correct_if", "horizon_days", "rating", "transcript"]
    assert "CONFIDENCE:" in defaults["confidence_judge"]["text"]


def test_defaults_route_requires_the_bearer(client: Any, client_with_bearer: Any) -> None:
    assert client.get("/agents/prompts/defaults").status_code == 401
    res = client_with_bearer.get("/agents/prompts/defaults")
    assert res.status_code == 200
    assert res.json()["risk_manager"]["text"] == _raw("risk_manager")


# --- judge template -------------------------------------------------------------


def _old_build_judge_prompt(state: dict, rating: str, horizon_days: int = 7) -> str:
    """The judge prompt as written before it became a template, kept verbatim."""
    correct_if = {
        "strong-buy": "the stock beats SPY by more than 0.5 percentage points",
        "buy": "the stock beats SPY by more than 0.5 percentage points",
        "hold": "the stock finishes within 1 percentage point of SPY",
        "reduce": "the stock trails SPY by more than 0.5 percentage points",
        "sell": "the stock trails SPY by more than 0.5 percentage points",
    }
    inv = state.get("investment_debate_state") or {}
    risk = state.get("risk_debate_state") or {}
    sections = [
        ("Bull researcher", inv.get("bull_history")),
        ("Bear researcher", inv.get("bear_history")),
        ("Research manager", inv.get("judge_decision")),
        ("Trader plan", state.get("trader_investment_plan")),
        ("Aggressive risk analyst", risk.get("aggressive_history")),
        ("Conservative risk analyst", risk.get("conservative_history")),
        ("Neutral risk analyst", risk.get("neutral_history")),
        ("Final decision", state.get("final_trade_decision")),
    ]
    body = "\n\n".join(f"## {title}\n{text}" for title, text in sections if text)
    return (
        "You are auditing a trading committee's decision. You did not take part in it.\n"
        f"The committee's final rating is {rating.upper()}. Over the next {horizon_days} "
        f"trading days, that rating counts as correct if {correct_if.get(rating, correct_if['hold'])}.\n\n"
        "Estimate the probability, from 0 to 100, that the rating turns out correct. "
        "Weigh how strong the winning evidence is, how well the losing side was answered, "
        "and how much a week of noise could swamp the thesis. A coin-flip call is 50; "
        "do not drift toward 50 to sound cautious, and do not round to a multiple of 5 "
        "or 10 unless that is your actual estimate.\n\n"
        "Reply with exactly two lines and nothing else:\n"
        "CONFIDENCE: <integer 0-100>\n"
        "REASON: <one sentence>\n\n"
        f"{body}"
    )


_STATE = {
    "investment_debate_state": {"bull_history": "Bull: {braces} stay literal", "bear_history": "Bear says no", "judge_decision": "Buy it"},
    "trader_investment_plan": "Plan: buy 10",
    "risk_debate_state": {"aggressive_history": "Go big", "conservative_history": "", "neutral_history": "Balanced"},
    "final_trade_decision": "FINAL TRANSACTION PROPOSAL: **BUY**",
}


@pytest.mark.parametrize("rating", ["strong-buy", "buy", "hold", "reduce", "sell", "unknown"])
def test_default_judge_prompt_is_unchanged(rating: str) -> None:
    assert confidence.build_judge_prompt(_STATE, rating) == _old_build_judge_prompt(_STATE, rating)
    assert confidence.build_judge_prompt({}, rating, 3) == _old_build_judge_prompt({}, rating, 3)


def test_judge_uses_the_run_override() -> None:
    token = prompts_mod.set_run_overrides(
        {"confidence_judge": "Rate {rating} over {horizon_days}d if {correct_if}.\n{transcript}\nCONFIDENCE: n"}
    )
    try:
        text = confidence.build_judge_prompt(_STATE, "buy")
    finally:
        prompts_mod.reset_run_overrides(token)
    assert text.startswith("Rate BUY over 7d if the stock beats SPY")
    assert "## Final decision" in text


def test_a_broken_judge_override_falls_back_to_the_default(caplog: pytest.LogCaptureFixture) -> None:
    token = prompts_mod.set_run_overrides({"confidence_judge": "Rate {unknown_field}"})
    try:
        with caplog.at_level(logging.WARNING):
            text = confidence.build_judge_prompt(_STATE, "buy")
    finally:
        prompts_mod.reset_run_overrides(token)
    assert text == _old_build_judge_prompt(_STATE, "buy")
    assert "confidence_judge" in caplog.text


# --- patched load_prompt --------------------------------------------------------


def test_every_node_module_gets_the_patched_loader() -> None:
    prompts_mod.install_prompt_overrides()
    for module_name in prompts_mod.NODE_MODULES:
        module = importlib.import_module(module_name)
        assert module.load_prompt is prompts_mod.load_prompt_with_overrides, module_name


def test_loader_returns_upstream_text_without_an_override() -> None:
    assert prompts_mod.load_prompt_with_overrides("trader_system") == ta_prompts.load_prompt("trader_system")


def test_loader_returns_the_override_plus_the_language_line() -> None:
    token = prompts_mod.set_run_overrides({"trader_system": "MARKER {past_memory_str}"})
    try:
        text = prompts_mod.load_prompt_with_overrides("trader_system")
    finally:
        prompts_mod.reset_run_overrides(token)
    assert text == "MARKER {past_memory_str}" + ta_prompts._language_instruction()


class _S(TypedDict):
    text: str


@pytest.mark.asyncio
async def test_override_reaches_a_sync_node_run_by_langgraph() -> None:
    """LangGraph runs sync nodes on an executor thread; the run's overrides
    must still be visible there, and must not leak to a concurrent run."""
    from tradingagents.agents.trader import trader as trader_mod

    prompts_mod.install_prompt_overrides()

    threads: list[str] = []

    def node(_state: _S) -> _S:
        threads.append(threading.current_thread().name)
        return {"text": trader_mod.load_prompt("trader_system")}

    builder = StateGraph(_S)
    builder.add_node("trader", node)
    builder.add_edge(START, "trader")
    builder.add_edge("trader", END)
    graph = builder.compile()

    async def run(overrides: dict[str, str]) -> str:
        prompts_mod.set_run_overrides(overrides)
        await asyncio.sleep(0)
        last: dict = {}
        async for chunk in graph.astream({"text": ""}, stream_mode="values"):
            last = chunk
        return last["text"]

    with_override, without = await asyncio.gather(
        asyncio.create_task(run({"trader_system": "RUN A MARKER"})),
        asyncio.create_task(run({})),
    )
    assert with_override.startswith("RUN A MARKER")
    assert without == ta_prompts.load_prompt("trader_system")
    # The node really ran off the event loop's thread, where only a copied context carries the var.
    assert threads and all(name != threading.current_thread().name for name in threads)


# --- fetching overrides -----------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_reads_overrides_with_the_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _serve(monkeypatch, lambda _r: httpx.Response(200, content=json.dumps({"overrides": {"trader_system": "X"}})))
    assert await prompts_mod.fetch_prompt_overrides() == {"trader_system": "X"}
    assert str(seen[0].url) == f"{get_settings().WEB_INTERNAL_BASE_URL}/api/internal/prompts"
    assert seen[0].headers["authorization"] == f"Bearer {get_settings().INTERNAL_BEARER}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "handler",
    [
        lambda _r: httpx.Response(500, content=b"boom"),
        lambda _r: httpx.Response(200, content=b"not json"),
        lambda _r: httpx.Response(200, content=json.dumps({"overrides": {"x": 1}})),
    ],
)
async def test_fetch_failure_means_defaults(monkeypatch: pytest.MonkeyPatch, handler: Any, caplog: pytest.LogCaptureFixture) -> None:
    _serve(monkeypatch, handler)
    with caplog.at_level(logging.WARNING):
        assert await prompts_mod.fetch_prompt_overrides() == {}
    assert "prompt overrides" in caplog.text


@pytest.mark.asyncio
async def test_fetch_survives_an_unreachable_web(monkeypatch: pytest.MonkeyPatch) -> None:
    def refuse(_r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    _serve(monkeypatch, refuse)
    assert await prompts_mod.fetch_prompt_overrides() == {}


@pytest.mark.asyncio
async def test_build_graph_locked_installs_the_run_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.agents import graph as graph_mod

    _serve(monkeypatch, lambda _r: httpx.Response(200, content=json.dumps({"overrides": {"trader_system": "BUILT"}})))
    monkeypatch.setattr(graph_mod, "build_graph", lambda *_a, **_k: object())
    await graph_mod.build_graph_locked(None)
    assert prompts_mod.load_prompt_with_overrides("trader_system").startswith("BUILT")
    prompts_mod.set_run_overrides({})
