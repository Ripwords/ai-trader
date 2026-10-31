"""The fundamentals and news analysts must be able to call the earnings tools.

Upstream TradingAgents hardcodes each analyst's tool list and binds the tool
objects it imported at load time, so a toolkit swap alone neither adds the new
tools nor puts our docstrings in front of the LLM. ``build_graph`` installs
its own analyst factories and ToolNodes for those two analysts.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage
from tradingagents.agents.utils.agent_states import AgentState

from app.services.agents.llm_config import LlmRuntimeConfig, RoleModel
from app.services.agents.toolkit import build_toolkit

EARNINGS = {"get_earnings_release", "get_earnings_surprise"}


def _role(kind: str) -> RoleModel:
    return RoleModel.model_validate({"kind": kind, "model_id": "m-1", "api_key": "sk-test", "base_url": None})


def _build(tmp_path: Any):
    from app.services.agents.graph import build_graph

    config = LlmRuntimeConfig(chat=_role("anthropic"), quick=_role("anthropic"))
    return build_graph(None, models=config, results_dir=tmp_path)


def test_fundamentals_and_news_tool_nodes_run_the_earnings_tools(tmp_path: Any) -> None:
    ta = _build(tmp_path)
    fundamentals = set(ta.tool_nodes["fundamentals"].tools_by_name)
    news = set(ta.tool_nodes["news"].tools_by_name)
    assert EARNINGS <= fundamentals
    assert {"get_fundamentals", "get_balance_sheet", "get_cashflow", "get_income_statement"} <= fundamentals
    assert EARNINGS <= news
    assert {"get_estimate_revisions", "get_earnings_call_transcript"} <= fundamentals
    assert "get_estimate_revisions" in news
    assert "get_earnings_call_transcript" not in news  # ~10k tokens; fundamentals only
    assert {"get_news", "get_global_news", "get_insider_transactions"} <= news
    assert set(ta.tool_nodes["market"].tools_by_name) == {"get_stock_data", "get_indicators"}


class _RecordingLLM:
    """Stands in for a chat model: records the tools bound and answers once."""

    def __init__(self) -> None:
        self.bound: list[Any] = []
        self.system: str = ""

    def bind_tools(self, tools: list[Any]) -> Any:
        self.bound = list(tools)
        from langchain_core.runnables import RunnableLambda

        def answer(prompt_value: Any) -> AIMessage:
            self.system = prompt_value.to_messages()[0].content
            return AIMessage(content="report")

        return RunnableLambda(answer)


def _state() -> AgentState:
    return AgentState(
        messages=[HumanMessage(content="AMZN")],
        company_of_interest="AMZN",
        trade_date="2026-10-31",
    )


def test_analyst_factories_bind_our_toolkit_including_earnings_tools() -> None:
    from app.services.agents.graph import fundamentals_analyst_factory, news_analyst_factory

    toolkit = build_toolkit(None)
    for factory, report_key in ((fundamentals_analyst_factory, "fundamentals_report"), (news_analyst_factory, "news_report")):
        llm = _RecordingLLM()
        out = factory(toolkit)(llm)(_state())
        names = {t.name for t in llm.bound}
        assert EARNINGS <= names
        # The bound objects are ours (our docstrings reach the LLM), not upstream's.
        assert toolkit.get_earnings_release in llm.bound
        assert out[report_key] == "report"
        assert "get_earnings_surprise" in llm.system  # tool_names placeholder filled
        assert "consensus" in llm.system  # earnings-aware default prompt


def test_build_graph_patches_setup_with_the_toolkit_factories(tmp_path: Any) -> None:
    from tradingagents.graph import setup as ta_setup

    _build(tmp_path)
    assert getattr(ta_setup.create_fundamentals_analyst, "__ai_trader_toolkit__", False)
    assert getattr(ta_setup.create_news_analyst, "__ai_trader_toolkit__", False)
