"""The Trader and the Risk Judge decide the trade, but upstream feeds them only
the plan and the debate. A fact the debaters never repeated (AMZN Q3 2026: the
EPS miss was last year's $9.5B Anthropic gain) could not reach the final call.
These tests pin that both now read the analyst reports."""

from __future__ import annotations

from langchain_core.messages import AIMessage
from tradingagents.agents.utils.agent_states import AgentState, RiskDebateState

from app.services.agents import graph as graph_mod
from app.services.agents.graph import (
    risk_manager_with_reports,
    trader_with_reports,
    with_analyst_reports,
)

FUNDAMENTALS = "EPS miss is last year's $9.5B Anthropic gain; operating income +61%."
NEWS = "Prime Day moved into Q2."


class FakeMemory:
    def get_memories(self, situation: str, n_matches: int = 2) -> list[dict]:
        return []


class FakeLlm:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.inputs: list[object] = []

    def invoke(self, prompt: object) -> AIMessage:
        self.inputs.append(prompt)
        return AIMessage(content=self.reply)


def _state(**over: object) -> AgentState:
    base: dict[str, object] = {
        "company_of_interest": "US.AMZN",
        "trade_date": "2026-10-31",
        "market_report": "Below the 200-day.",
        "sentiment_report": "",
        "news_report": NEWS,
        "fundamentals_report": FUNDAMENTALS,
        "investment_plan": "Research plan: SELL.",
        "trader_investment_plan": "Trader plan: reduce to underweight.",
        "risk_debate_state": RiskDebateState(history="Aggressive: short it."),
    }
    base.update(over)
    return AgentState(**base)


def _text(llm_input: object) -> str:
    if isinstance(llm_input, str):
        return llm_input
    return "\n".join(m["content"] for m in llm_input)  # type: ignore[union-attr]


def test_appends_every_non_empty_report_after_the_plan() -> None:
    out = with_analyst_reports("PLAN", _state())
    assert out.startswith("PLAN")
    assert FUNDAMENTALS in out and NEWS in out and "Below the 200-day." in out
    # The empty social report adds no section.
    assert "Social" not in out


def test_no_reports_leaves_the_plan_untouched() -> None:
    state = _state(market_report="", news_report="", fundamentals_report="")
    assert with_analyst_reports("PLAN", state) == "PLAN"


def test_trader_sees_the_reports_and_keeps_its_own_output() -> None:
    llm = FakeLlm("Trade plan. FINAL TRANSACTION PROPOSAL: **SELL**")
    node = trader_with_reports(llm, FakeMemory())
    result = node(_state())
    prompt = _text(llm.inputs[0])
    assert "Research plan: SELL." in prompt
    assert FUNDAMENTALS in prompt
    assert result["trader_investment_plan"] == "Trade plan. FINAL TRANSACTION PROPOSAL: **SELL**"


def test_risk_judge_sees_the_reports_and_the_debate() -> None:
    llm = FakeLlm("Ruling. FINAL TRANSACTION PROPOSAL: **HOLD**")
    node = risk_manager_with_reports(llm, FakeMemory())
    result = node(_state())
    prompt = _text(llm.inputs[0])
    assert "Trader plan: reduce to underweight." in prompt
    assert "Aggressive: short it." in prompt
    assert FUNDAMENTALS in prompt and NEWS in prompt
    assert result["final_trade_decision"] == "Ruling. FINAL TRANSACTION PROPOSAL: **HOLD**"
    # The reports are prompt input only; they never leak into saved state.
    assert "trader_investment_plan" not in result


def test_install_wires_both_wrappers_once() -> None:
    from tradingagents.graph import setup as setup_mod

    toolkit = graph_mod.build_toolkit(None)
    graph_mod._install_toolkit(toolkit)
    graph_mod._install_toolkit(toolkit)
    assert setup_mod.create_trader is trader_with_reports
    assert setup_mod.create_risk_manager is risk_manager_with_reports

    llm = FakeLlm("ok")
    setup_mod.create_risk_manager(llm, FakeMemory())(_state())
    assert _text(llm.inputs[0]).count(FUNDAMENTALS) == 1
