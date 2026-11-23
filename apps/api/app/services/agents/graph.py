"""TradingAgents LangGraph wiring + stream adapter.

What we take from tradingagents (0.5.0, pinned in ``uv.lock``) and what we own:

1. Configuration is a typed pydantic model,
   :class:`tradingagents.config.TradingAgentsConfig`. There is no
   ``DEFAULT_CONFIG``.
2. :class:`tradingagents.graph.trading_graph.TradingAgentsGraph` does not
   accept a toolkit, and its own graph runs the four analysts one after
   another on a shared ``messages`` list. ``build_graph`` therefore compiles
   the workflow itself (:func:`_compile_graph`) and seeds it onto the
   instance: the analysts fan out, each on a private conversation with our
   HTTP-backed tools, and the Bull Researcher waits for all of them. The
   debate, trader and risk stages are upstream's nodes in upstream's order.
3. ``max_debate_rounds`` is read once, when the graph is compiled. Per-run
   overrides must be passed to :func:`build_graph`.
4. The stream is ``graph_obj.graph.astream(state, **graph_args)`` with
   ``stream_mode="values"``: one full state snapshot per graph step, with no
   ``metadata.langgraph_node``. A step can hold several analysts' work.
5. Conversations hold langchain ``BaseMessage`` subclasses; tool calls live on
   ``AIMessage.tool_calls`` and tool results arrive as ``ToolMessage``.

``run_graph`` diffs successive snapshots into the **normalized** chunk shape
:func:`app.services.agents.streaming.translate_chunks` expects. Tool calls and
results come from each analyst's own conversation; debate rounds and decisions
come from changes to ``investment_debate_state`` and ``final_trade_decision``.

Checkpointing:

- The saver is shared across runs. It is owned by the FastAPI lifespan and
  lives on ``app.state.checkpointer``; ``build_graph`` compiles it in.
  ``run_graph`` threads the per-run ``thread_id`` (== our ``run_id``) into the
  LangGraph config so checkpoints associate with the right run.
- ``app.state.checkpointer`` is ``None`` when ``DATABASE_URL`` isn't set (unit
  tests, dev without DB), which compiles a graph that keeps no checkpoints.
- A checkpoint taken while the analysts are working records which of them
  finished, so a resume reruns only the rest.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Awaitable, Callable, Literal

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, RemoveMessage, ToolMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.types import Command
from pydantic import BaseModel, Field
from tradingagents.agents import (
    AgentState,
    create_aggressive_debator,
    create_bear_researcher,
    create_bull_researcher,
    create_conservative_debator,
    create_neutral_debator,
    create_research_manager,
)
from tradingagents.agents.managers.risk_manager import (
    create_risk_manager as _upstream_create_risk_manager,
)
from tradingagents.agents.trader.trader import create_trader as _upstream_create_trader
from tradingagents.config import TradingAgentsConfig
from tradingagents.graph.conditional_logic import ConditionalLogic
from tradingagents.graph.setup import GraphSetup
from tradingagents.graph.trading_graph import TradingAgentsGraph

from .confidence import judge_confidence
from .deepseek_compat import install_litellm_thinking_patch
from . import llm_config
from . import prompts as prompts_mod
from .llm_config import LlmRuntimeConfig
from .owner import format_owner_context, owner_mandate
from .run_context import ContextLlm, RunContext
from .toolkit import AgentToolkit, OpenDClient, build_toolkit
from app.schemas.agents import OwnerContext
from app.services.valuation.compose import apply_veto, value
from app.services.valuation.fetch import fetch_valuation_input
from app.services.valuation.models import ValuationResult
from app.services.valuation.persist import record_valuation_snapshot
from app.services.valuation.summary import format_valuation_for_agents

logger = logging.getLogger(__name__)


# ``TradingAgentsGraph(...)`` registers its config as tradingagents' process-wide
# active config (``set_config``), which the prompt loader reads for the response
# language. The lock keeps one build's construct-and-compile from interleaving
# with another's.
_build_lock = asyncio.Lock()

# Every node module reads its prompt through the override-aware loader.
prompts_mod.install_prompt_overrides()

Judge = Callable[[dict, str], Awaitable[int | None]]


# Tools each analyst may call. Upstream hardcodes 4 for fundamentals and 3 for
# news; we add the earnings tools so a post-earnings run can compare the print
# with consensus and read the company's own release (drivers, one-offs,
# segments, guidance) before calling it a beat or a miss.
_FUNDAMENTALS_TOOLS = (
    "get_fundamentals",
    "get_balance_sheet",
    "get_cashflow",
    "get_income_statement",
    "get_earnings_surprise",
    "get_earnings_release",
    "get_estimate_revisions",
    "get_earnings_call_transcript",
)
# The transcript (~10k tokens) stays with fundamentals only; news gets the
# compact revisions table.
_NEWS_TOOLS = (
    "get_news",
    "get_global_news",
    "get_insider_transactions",
    "get_earnings_surprise",
    "get_earnings_release",
    "get_estimate_revisions",
)
_MARKET_TOOLS = ("get_stock_data", "get_indicators")
_SOCIAL_TOOLS = ("get_news",)


@dataclass(frozen=True)
class Analyst:
    """One analyst: its prompt, its tools, and where its work lands."""

    key: str  # the name ``selected_analysts`` uses
    prompt: str
    tools: tuple[str, ...]
    report: str  # AgentState field holding the finished report
    kind: str  # tag on the report's stream event

    @property
    def label(self) -> str:
        return f"{self.key.capitalize()} Analyst"

    @property
    def channel(self) -> str:
        return f"{self.key}_messages"

    @property
    def tools_node(self) -> str:
        return f"tools_{self.key}"

    @property
    def clear_node(self) -> str:
        return f"Msg Clear {self.key.capitalize()}"


ANALYSTS = (
    Analyst("market", "market_analyst", _MARKET_TOOLS, "market_report", "market"),
    Analyst("social", "social_media_analyst", _SOCIAL_TOOLS, "sentiment_report", "sentiment"),
    Analyst("news", "news_analyst", _NEWS_TOOLS, "news_report", "news"),
    Analyst("fundamentals", "fundamentals_analyst", _FUNDAMENTALS_TOOLS, "fundamentals_report", "fundamentals"),
)
_ANALYST_BY_KEY = {analyst.key: analyst for analyst in ANALYSTS}


class RunState(AgentState):
    """Upstream's state plus a private conversation per analyst.

    Upstream's analysts share ``messages``, which is the only thing that made
    them take turns: two tool loops on one list would read each other's calls
    and results. One field per :class:`Analyst` ``channel``.
    """

    market_messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)
    social_messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)
    news_messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)
    fundamentals_messages: Annotated[list[AnyMessage], add_messages] = Field(default_factory=list)


def analyst_node(
    analyst: Analyst, toolkit: AgentToolkit, llm: Any, *, leads: bool
) -> Callable[[Any], Command]:
    """An analyst node that binds *our* tool objects to the LLM.

    Mirrors the upstream ``create_*_analyst`` node bodies (tradingagents
    0.5.0) with three differences: the tool list comes from the per-run
    toolkit (so the LLM sees our docstrings and the earnings tools), the
    system prompt is read through the override-aware loader, and the
    conversation is the analyst's own.

    ``leads`` marks the first selected analyst. In upstream's chain its
    conversation opened with the symbol and every later analyst's opened with
    the "Continue" the previous Msg Clear left behind. Each conversation opens
    the same way here, so every analyst gets the input it got in the chain.

    The node names its own next step. When one analyst fails LangGraph cancels
    the others and checkpoints whatever each had written, then treats those as
    finished on resume. A conditional edge is a second write after the state
    update, so a cancel between the two saved a report with nowhere to go and
    the resumed run ended before the debate. A ``Command`` is one write.
    """
    tools = [getattr(toolkit, attr) for attr in analyst.tools]
    tool_names = ", ".join(t.name for t in tools)

    def node(state: Any) -> Command:
        prompt = ChatPromptTemplate.from_messages([
            ("system", prompts_mod.load_prompt_with_overrides(analyst.prompt)),
            MessagesPlaceholder(variable_name="messages"),
        ])
        prompt = prompt.partial(
            tool_names=tool_names,
            current_date=state.trade_date,
            ticker=state.company_of_interest,
        )
        conversation = getattr(state, analyst.channel)
        opening = [] if conversation else [
            HumanMessage(content=state.company_of_interest if leads else "Continue")
        ]
        result = (prompt | llm.bind_tools(tools)).invoke([*opening, *conversation])
        report = "" if result.tool_calls else result.content
        return Command(
            update={analyst.channel: [*opening, result], analyst.report: report},
            goto=analyst.tools_node if result.tool_calls else analyst.clear_node,
        )

    node.__name__ = f"{analyst.prompt}_node"
    return node


_REPORT_SECTIONS = (
    ("market_report", "Market analyst"),
    ("sentiment_report", "Social analyst"),
    ("news_report", "News analyst"),
    ("fundamentals_report", "Fundamentals analyst"),
)


def with_analyst_reports(plan: str, state: Any) -> str:
    """``plan`` followed by the analyst reports, for the two roles upstream
    feeds only a plan: the Trader and the Risk Judge. Without them the final
    call sees only the facts a debater happened to repeat."""
    sections = [
        f"### {title}\n{text}"
        for field, title in _REPORT_SECTIONS
        if (text := getattr(state, field, "") or "")
    ]
    if not sections:
        return plan
    return (
        f"{plan}\n\n## Analyst reports (source evidence)\n"
        "Check the plan and the debate against these reports, and weigh any "
        "material fact in them that the debate left out.\n\n" + "\n\n".join(sections)
    )


class _NoMemory:
    """Stands in for upstream's per-role memory of past trades. Nothing here
    ever stores a lesson, and upstream's empty memory hands the node an empty
    string (or "No past memories found."), which a prompt asking for lessons
    reads as lessons to make up. The default prompts no longer ask; a saved
    override that still has ``{past_memory_str}`` gets this instead."""

    def get_memories(self, _situation: str, n_matches: int = 1) -> list[dict[str, str]]:
        return [{"recommendation": prompts_mod.NO_MEMORY_VALUE}]


def trader_with_reports(llm: Any, memory: Any) -> Callable[[Any], dict[str, Any]]:
    node = _upstream_create_trader(llm, memory)

    def trader_node(state: Any) -> dict[str, Any]:
        plan = with_analyst_reports(state.investment_plan, state)
        return node(state.model_copy(update={"investment_plan": plan}))

    return trader_node


def risk_manager_with_reports(llm: Any, memory: Any) -> Callable[[Any], dict[str, Any]]:
    node = _upstream_create_risk_manager(llm, memory)

    def risk_manager_node(state: Any) -> dict[str, Any]:
        plan = with_analyst_reports(state.trader_investment_plan, state)
        return node(state.model_copy(update={"trader_investment_plan": plan}))

    return risk_manager_node


def _tool_nodes(toolkit: AgentToolkit) -> dict[str, Any]:
    """Each analyst's ToolNode, reading and answering on that analyst's own
    conversation (seeded onto ``ta``)."""
    return {
        analyst.key: ToolNode(
            [getattr(toolkit, attr) for attr in analyst.tools], messages_key=analyst.channel
        )
        for analyst in ANALYSTS
    }


def _clear_conversation(analyst: Analyst) -> Callable[[Any], dict[str, Any]]:
    """The report is all the debate reads, so the finished tool loop is dropped
    rather than carried in every later checkpoint."""

    def clear(state: Any) -> dict[str, Any]:
        return {analyst.channel: [RemoveMessage(id=m.id) for m in getattr(state, analyst.channel)]}

    return clear


def _compile_graph(
    ta: TradingAgentsGraph, toolkit: AgentToolkit, checkpointer: BaseCheckpointSaver | None
) -> Any:
    """Upstream's workflow with the analyst stage fanned out.

    Upstream chains the analysts (analyst, its tools, Msg Clear, next analyst).
    No analyst reads another's report, so here they all start at once and the
    Bull Researcher waits for every one of them. From the Bull Researcher on,
    the wiring is upstream's ``GraphSetup.setup_graph`` edge for edge; a test
    compares the two, because each speaker in both debates answers the one
    before it and that order is part of the result.
    """
    selected = [
        _ANALYST_BY_KEY[key]
        for key in GraphSetup.validate_selected_analysts(ta.selected_analysts)
    ]
    quick, deep = ta.quick_thinking_llm, ta.deep_thinking_llm
    logic = ConditionalLogic(
        max_debate_rounds=ta.config.max_debate_rounds,
        max_risk_discuss_rounds=ta.config.max_risk_discuss_rounds,
    )

    workflow = StateGraph(RunState)
    for position, analyst in enumerate(selected):
        workflow.add_node(
            analyst.label,
            analyst_node(analyst, toolkit, quick, leads=position == 0),
            destinations=(analyst.tools_node, analyst.clear_node),
        )
        workflow.add_node(analyst.tools_node, ta.tool_nodes[analyst.key])
        workflow.add_node(analyst.clear_node, _clear_conversation(analyst))
        workflow.add_edge(START, analyst.label)
        workflow.add_edge(analyst.tools_node, analyst.label)

    # The analysts keep the bare model: the run's context is not ready while
    # they work, and they bind tools to it.
    # The three nodes that decide also get the owner mandate.
    argues = ContextLlm(quick, ta.run_context)
    quick_decides = ContextLlm(quick, ta.run_context, decides=True)
    deep_decides = ContextLlm(deep, ta.run_context, decides=True)
    memory = _NoMemory()
    workflow.add_node("Bull Researcher", create_bull_researcher(argues, memory))
    workflow.add_node("Bear Researcher", create_bear_researcher(argues, memory))
    workflow.add_node("Research Manager", create_research_manager(deep_decides, memory))
    workflow.add_node("Trader", trader_with_reports(quick_decides, memory))
    workflow.add_node("Aggressive Analyst", create_aggressive_debator(argues))
    workflow.add_node("Neutral Analyst", create_neutral_debator(argues))
    workflow.add_node("Conservative Analyst", create_conservative_debator(argues))
    workflow.add_node("Risk Judge", risk_manager_with_reports(deep_decides, memory))

    workflow.add_edge([analyst.clear_node for analyst in selected], "Bull Researcher")
    workflow.add_conditional_edges(
        "Bull Researcher",
        logic.should_continue_debate,
        {"Bear Researcher": "Bear Researcher", "Research Manager": "Research Manager"},
    )
    workflow.add_conditional_edges(
        "Bear Researcher",
        logic.should_continue_debate,
        {"Bull Researcher": "Bull Researcher", "Research Manager": "Research Manager"},
    )
    workflow.add_edge("Research Manager", "Trader")
    workflow.add_edge("Trader", "Aggressive Analyst")
    workflow.add_conditional_edges(
        "Aggressive Analyst",
        logic.should_continue_risk_analysis,
        {"Conservative Analyst": "Conservative Analyst", "Risk Judge": "Risk Judge"},
    )
    workflow.add_conditional_edges(
        "Conservative Analyst",
        logic.should_continue_risk_analysis,
        {"Neutral Analyst": "Neutral Analyst", "Risk Judge": "Risk Judge"},
    )
    workflow.add_conditional_edges(
        "Neutral Analyst",
        logic.should_continue_risk_analysis,
        {"Aggressive Analyst": "Aggressive Analyst", "Risk Judge": "Risk Judge"},
    )
    workflow.add_edge("Risk Judge", END)
    return workflow.compile(checkpointer=checkpointer)


def build_graph(
    opend_client: OpenDClient | None,
    *,
    models: LlmRuntimeConfig,
    max_debate_rounds: int = 1,
    max_risk_discuss_rounds: int = 1,
    deep_thinking: bool = True,
    reasoning_effort: str = "medium",
    response_language: str = "en-US",
    selected_analysts: list[str] | None = None,
    company_name: str | None = None,
    owner_context: OwnerContext | None = None,
    results_dir: Path | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> TradingAgentsGraph:
    """Construct a TradingAgentsGraph wired to our toolkit and config.

    ``deep_thinking`` is layered on top of ``reasoning_effort``: when False
    we override whatever effort was passed to ``"low"`` (the lowest effort TradingAgents accepts) so a single
    cheap+fast pass runs even if the caller forgot to lower the effort.
    Otherwise ``reasoning_effort`` is honoured verbatim
    (``low|medium|high|xhigh|max``) and mapped to the provider-native knob
    inside TradingAgents' ``build_chat_model``.

    ``selected_analysts`` chooses which of the four analyst nodes
    (``market``/``social``/``news``/``fundamentals``) actually run. Skipping
    ``social`` typically saves ~20% of the LLM cost on a run; skipping
    ``news`` saves another ~15%. ``None`` defaults to all four.

    ``checkpointer`` (optional) — the saver the graph is compiled with, so a
    halted run can resume. ``None`` compiles a graph that keeps no checkpoints.

    ``models`` supplies the deep agents (chat role) and the fast ones (quick
    role), each with its own provider and key.
    """
    effort = "low" if not deep_thinking else reasoning_effort
    cfg = TradingAgentsConfig(
        llm_provider=llm_config.ta_provider(models.chat.kind),
        deep_think_llm=models.chat.model_id,
        quick_think_llm=models.quick.model_id,
        reasoning_effort=effort,
        response_language=response_language,
        max_debate_rounds=max_debate_rounds,
        max_risk_discuss_rounds=max_risk_discuss_rounds,
        max_recur_limit=100,
        results_dir=results_dir or Path("./results"),
    )
    # DeepSeek's remaining models all run in thinking mode, and LangChain's
    # reasoning content blocks are rejected if echoed back — which breaks the
    # second turn of every tool loop. Idempotent, and a no-op for providers
    # that aren't litellm-routed.
    install_litellm_thinking_patch()
    toolkit = build_toolkit(opend_client, company_name=company_name)
    # ``selected_analysts`` defaults to TradingAgents' four analysts.
    ta_kwargs: dict[str, Any] = {"config": cfg, "debug": False}
    if selected_analysts is not None:
        ta_kwargs["selected_analysts"] = selected_analysts
    ta = TradingAgentsGraph(**ta_kwargs)
    # TradingAgents builds both models from one provider and the environment.
    # Seeding its cached properties gives each role its own provider and key.
    ta.__dict__["deep_thinking_llm"] = llm_config.build_role_model(models.chat, reasoning_effort=effort)
    ta.__dict__["quick_thinking_llm"] = llm_config.build_role_model(models.quick, reasoning_effort=effort)
    # Seeded for the same reason: upstream's own ToolNodes and graph bind its
    # bundled tools and run the analysts one after another.
    ta.__dict__["tool_nodes"] = _tool_nodes(toolkit)
    ta.__dict__["run_context"] = RunContext()
    ta.__dict__["owner_context"] = owner_context
    ta.__dict__["graph"] = _compile_graph(ta, toolkit, checkpointer)
    return ta


async def build_graph_locked(
    opend_client: OpenDClient | None,
    *,
    max_debate_rounds: int = 1,
    max_risk_discuss_rounds: int = 1,
    deep_thinking: bool = True,
    reasoning_effort: str = "medium",
    response_language: str = "en-US",
    selected_analysts: list[str] | None = None,
    company_name: str | None = None,
    owner_context: OwnerContext | None = None,
    results_dir: Path | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> TradingAgentsGraph:
    """Async wrapper around :func:`build_graph` that holds :data:`_build_lock`.

    Use this from request handlers; the lock guarantees that the toolkit
    monkey-patch + graph compile are not racing across concurrent runs. The
    underlying :func:`build_graph` is sync, so we run it on a worker thread
    via :func:`asyncio.to_thread` to keep the event loop responsive while
    LangGraph's compile step runs (it can be O(100 ms) on a cold path).
    The models are read from web's Settings first, outside the lock.
    """
    # We resolve ``build_graph`` lazily off the module so tests can patch it
    # via ``monkeypatch.setattr(graph_mod, "build_graph", ...)`` without
    # losing the lock semantics they're trying to verify.
    import sys

    models, overrides = await asyncio.gather(
        llm_config.fetch_llm_config(), prompts_mod.fetch_prompt_overrides()
    )
    # Set here, not inside the gathered task, so it lands in the caller's
    # context: the run streams from this task or from one it spawns next.
    prompts_mod.set_run_overrides(overrides)
    async with _build_lock:
        target = getattr(sys.modules[__name__], "build_graph")
        return await asyncio.to_thread(
            target,
            opend_client,
            models=models,
            max_debate_rounds=max_debate_rounds,
            max_risk_discuss_rounds=max_risk_discuss_rounds,
            deep_thinking=deep_thinking,
            reasoning_effort=reasoning_effort,
            response_language=response_language,
            selected_analysts=selected_analysts,
            company_name=company_name,
            owner_context=owner_context,
            results_dir=results_dir,
            checkpointer=checkpointer,
        )


def _normalize_chunk(node: str | None, values: dict[str, Any], finished: bool) -> dict:
    """Wrap a per-step delta in our normalized chunk shape."""
    return {
        "metadata": {"langgraph_node": node, "node_finished": finished},
        "values": values,
    }


# The debate stage that just finished, by the AgentState field it wrote. The
# analysts are attributed from their own conversations and reports instead.
_STAGE_NODES = {
    "investment_plan": "Research Manager",
    "trader_investment_plan": "Trader",
    "final_trade_decision": "Risk Manager",
}


def _detect_node(prev: dict, curr: dict) -> str | None:
    """Pick a stage label by spotting which AgentState field changed."""
    for field, label in _STAGE_NODES.items():
        if (curr.get(field) or "") != (prev.get(field) or ""):
            return label
    return None


def _new_messages(prev: list, curr: list) -> list:
    """Return messages added since the previous snapshot.

    LangGraph's ``add_messages`` reducer guarantees stable ids; a Msg Clear
    node can shrink the list, so we identify additions by id rather than by
    list-tail comparison.
    """
    prev_ids = {getattr(m, "id", None) for m in prev}
    return [m for m in curr if getattr(m, "id", None) not in prev_ids]


def _extract_tool_events(new_msgs: list) -> tuple[list[dict], list[dict]]:
    """Split new messages into tool-call requests and tool-result responses."""
    calls: list[dict] = []
    results: list[dict] = []
    for m in new_msgs:
        if isinstance(m, AIMessage):
            for tc in getattr(m, "tool_calls", None) or []:
                calls.append({"name": tc.get("name"), "args": tc.get("args") or {}})
        elif isinstance(m, ToolMessage):
            content = m.content if isinstance(m.content, str) else str(m.content)
            results.append(
                {
                    "name": getattr(m, "name", None),
                    "ok": getattr(m, "status", "success") != "error",
                    "preview": content,
                }
            )
    return calls, results


def _extract_debate(prev: dict, curr: dict) -> dict | None:
    """Detect a new bull/bear turn by comparing investment_debate_state.count."""
    pdb = prev.get("investment_debate_state") or {}
    cdb = curr.get("investment_debate_state") or {}
    pcount = pdb.get("count", 0)
    ccount = cdb.get("count", 0)
    if ccount <= pcount:
        return None
    text = cdb.get("current_response", "") or ""
    # Bull turns are the odd-numbered counts (1, 3, ...) under tradingagents'
    # bull-first ordering; even-numbered are bear.
    side = "bull" if ccount % 2 == 1 else "bear"
    return {"round": (ccount + 1) // 2, "side": side, "text": text}


def _extract_reports(prev: dict, curr: dict) -> list[dict]:
    """Return one entry per analyst report that just landed.

    TradingAgents writes each analyst's full markdown report into its own
    AgentState field at the end of that node's run. Earlier we only surfaced
    a 500-char ``summary`` truncation in ``node-end`` — the bulk of the
    pipeline's output never reached the UI. Now we emit a separate ``report``
    event with the full markdown so the UI can render each analyst's full
    research note.

    ``kind`` is what the UI uses to colour-code and route the report; ``node``
    matches the label on the analyst's other events so the report attaches to
    the right step card.
    """
    out: list[dict] = []
    for analyst in ANALYSTS:
        pval = prev.get(analyst.report) or ""
        cval = curr.get(analyst.report) or ""
        if cval and cval != pval:
            out.append({"kind": analyst.kind, "node": analyst.label, "content": cval})
    return out


def _extract_synthesis(prev: dict, curr: dict) -> list[dict]:
    """Surface the Research Manager + Trader plans as standalone artifacts.

    These intermediate syntheses (``investment_plan`` from the Research
    Manager, ``trader_investment_plan`` from the Trader) are full markdown
    documents in their own right but were getting swallowed by the
    truncated node-end summary. Each becomes a ``synthesis`` event with a
    distinct ``stage`` so the UI can place them between debate and verdict.
    """
    out: list[dict] = []
    p_inv = prev.get("investment_plan") or ""
    c_inv = curr.get("investment_plan") or ""
    if c_inv and c_inv != p_inv:
        out.append({"stage": "investment-plan", "node": "Research Manager", "content": c_inv})
    p_tr = prev.get("trader_investment_plan") or ""
    c_tr = curr.get("trader_investment_plan") or ""
    if c_tr and c_tr != p_tr:
        out.append({"stage": "trader-plan", "node": "Trader", "content": c_tr})
    # The Research Manager's ``judge_decision`` on the bull/bear debate is its
    # own artifact only when it says something the plan doesn't: tradingagents
    # 0.5.0 writes one reply to both fields, and the page would show it twice.
    pdb = prev.get("investment_debate_state") or {}
    cdb = curr.get("investment_debate_state") or {}
    pj = pdb.get("judge_decision") or ""
    cj = cdb.get("judge_decision") or ""
    if cj and cj != pj and cj != c_inv:
        out.append({"stage": "judge-decision", "node": "Research Manager", "content": cj})
    return out


# Map ``current_<speaker>_response`` field → speaker label. The risk debate
# is three-way (aggressive vs conservative vs neutral) and rotates through
# them; we identify whose turn just fired by ``latest_speaker`` from the
# state, falling back to whichever response field changed.
_RISK_SPEAKERS: tuple[tuple[str, str], ...] = (
    ("current_aggressive_response",  "aggressive"),
    ("current_conservative_response", "conservative"),
    ("current_neutral_response",     "neutral"),
)


def _extract_risk_debate(prev: dict, curr: dict) -> dict | None:
    """Detect a new turn in the three-way risk debate.

    Driven by ``risk_debate_state.count`` so a quiet round (no text but the
    speaker pointer advanced) doesn't produce a ghost event. The speaker is
    inferred from which ``current_<X>_response`` field changed — more
    reliable than ``latest_speaker``, which lags by one tick in some
    upstream branches.
    """
    pdb = prev.get("risk_debate_state") or {}
    cdb = curr.get("risk_debate_state") or {}
    pcount = pdb.get("count", 0)
    ccount = cdb.get("count", 0)
    if ccount <= pcount:
        return None
    speaker: str | None = None
    text: str = ""
    for field, label in _RISK_SPEAKERS:
        if (cdb.get(field) or "") != (pdb.get(field) or ""):
            speaker = label
            text = cdb.get(field) or ""
            break
    if speaker is None:
        # Fallback: trust ``latest_speaker``. TradingAgents stores it as a
        # human-readable name (``"Risky Analyst"``) so we normalise.
        raw = (cdb.get("latest_speaker") or "").lower()
        if "aggress" in raw or "risky" in raw:
            speaker = "aggressive"
        elif "conserv" in raw or "safe" in raw:
            speaker = "conservative"
        elif "neutral" in raw:
            speaker = "neutral"
        else:
            return None
    return {"speaker": speaker, "text": text, "turn": ccount}


# Match the five wire-supported rating buckets in the trader's free-text
# decision. Order matters: we test ``strong-buy`` / ``strong-sell`` before
# the plain ``buy`` / ``sell`` regexes so a ``STRONG BUY`` doesn't get
# clobbered into ``buy``. ``\W*`` between ``strong`` and ``buy``/``sell``
# tolerates hyphen, space, or no separator (``STRONG-BUY``, ``STRONG BUY``,
# ``STRONGBUY``). All matches are case-insensitive at the call site.
_RATING_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # ``strong-sell`` isn't a wire rating — collapse it to ``sell`` (still
    # bearish) without letting the regex below mistake it for a plain
    # ``sell`` and skip the plain ``buy`` branch's eagerness.
    ("sell", re.compile(r"\bstrong\W*sell\b", re.IGNORECASE)),
    ("strong-buy", re.compile(r"\bstrong\W*buy\b", re.IGNORECASE)),
    ("reduce", re.compile(r"\breduce\b", re.IGNORECASE)),
    # Use word boundaries so ``buyers``/``selling`` don't trip the match.
    ("sell", re.compile(r"\bsell\b", re.IGNORECASE)),
    ("buy", re.compile(r"\bbuy\b", re.IGNORECASE)),
    ("hold", re.compile(r"\bhold\b", re.IGNORECASE)),
)

# Explicit verdict markers other than the canonical ``FINAL TRANSACTION
# PROPOSAL`` line — the Risk Manager / synthesis often *leads* with one
# (e.g. ``Final Recommendation: HOLD``). We anchor on the marker and read the
# verdict token that immediately follows it, so an incidental ``sell`` buried
# elsewhere in the rationale body can't override the stated decision.
_VERDICT_MARKER_PATTERN = re.compile(
    r"(?:final\s+recommendation|recommendation|final\s+decision|"
    r"final\s+verdict|verdict|final\s+rating|final\s+call|conclusion|final)"
    r"\s*[:\-–—]+\s*\*{0,2}\s*"
    r"(strong[\W_]*buy|strong[\W_]*sell|reduce|buy|sell|hold)\b",
    re.IGNORECASE,
)


_FINAL_MARKER_PATTERN = re.compile(
    r"FINAL\s+TRANSACTION\s+PROPOSAL\s*:[\s*]*(BUY|SELL|HOLD)\b", re.IGNORECASE
)


def _regex_rating(text: str) -> str | None:
    """First matching 5-bucket rating from the priority-ordered regex, or None.

    This is a whole-text scan, so it is only a *fallback* — a long rationale
    that merely discusses selling will match ``sell`` here even when the verdict
    is HOLD. Callers must consult the authoritative markers first (see
    :func:`_parse_rating`) and reach for this only when no marker is present.
    """
    for label, pattern in _RATING_PATTERNS:
        if pattern.search(text):
            return label
    return None


def _canonical_signal(text: str) -> str | None:
    """Coarse ``buy``/``sell``/``hold`` from TradingAgents' deterministic
    extractor, or None when it can't decide.

    The extractor prioritises the canonical ``FINAL TRANSACTION PROPOSAL: <X>``
    marker the Risk Manager is prompted to emit and rejects ambiguous text
    (raising ``ValueError``), which we treat as "no authoritative signal".

    The extractor also gives up when two markers disagree. The Risk Manager
    refines the trader's plan and can quote the trader's marker before its
    own, so the last marker is the verdict.
    """
    markers = _FINAL_MARKER_PATTERN.findall(text)
    if markers:
        return markers[-1].lower()
    try:
        from tradingagents.graph.signal_processing import extract_trade_signal
        signal = extract_trade_signal(text).lower()
        return signal if signal in {"buy", "sell", "hold"} else None
    except (ValueError, ImportError):
        return None


def _parse_rating(text: str) -> str:
    """Return the wire rating for ``text`` (defaults to ``hold``).

    The decision text is a full multi-paragraph report that *discusses* the
    bull and bear cases before landing on a verdict. The author's actual
    verdict is stated explicitly — either as the canonical
    ``FINAL TRANSACTION PROPOSAL: **X**`` line or a leading
    ``Final Recommendation: X`` header. Those markers are AUTHORITATIVE and
    must outrank any incidental ``buy``/``sell`` mention in the body; resolving
    by a bare whole-text regex (the old behaviour) misread balanced HOLD
    writeups as SELL because ``sell`` outranks ``hold`` and matches first.

    Resolution order:

    1. **Canonical marker** (``extract_trade_signal``) — coarse buy/sell/hold.
       Refine ``buy`` → ``strong-buy`` when the prose says so, since the marker
       only carries three buckets but our taxonomy has five.
    2. **Verdict header** (``Final Recommendation: …``) — read the 5-bucket
       rating from the token right after the marker.
    3. **Whole-text regex** — last-resort fallback when no marker exists.
    4. ``hold`` — nothing matched.
    """
    regex = _regex_rating(text)

    # 1. Canonical FINAL TRANSACTION PROPOSAL marker — authoritative.
    coarse = _canonical_signal(text)
    if coarse is not None:
        if coarse == "buy" and regex == "strong-buy":
            return "strong-buy"
        return coarse

    # 2. Explicit verdict header (e.g. "Final Recommendation: HOLD").
    marker = _VERDICT_MARKER_PATTERN.search(text)
    if marker:
        header_rating = _regex_rating(marker.group(1))
        if header_rating is not None:
            return header_rating

    # 3/4. Fall back to the noisy whole-text scan, then hold.
    return regex or "hold"


# The verdict the owner mandate asks the deciding nodes for. A judge that
# quotes the trader's line before giving its own states its own last.
_OWNER_VERDICT_PATTERN = re.compile(
    r"OWNER\s+VERDICT\s*:[\s*_`]*(DO\s+NOT\s+ADD|ADD|HOLD|TRIM)\b", re.IGNORECASE
)
_OWNER_VERDICT_RATING = {"add": "buy", "hold": "hold", "trim": "reduce", "do-not-add": "hold"}


def _parse_owner_verdict(text: str) -> str | None:
    """``add``, ``hold``, ``trim`` or ``do-not-add`` from the last
    ``OWNER VERDICT:`` line, or None when the text has none."""
    verdicts = _OWNER_VERDICT_PATTERN.findall(text)
    if not verdicts:
        return None
    return "-".join(verdicts[-1].lower().split())


def _extract_decision(
    prev: dict,
    curr: dict,
    valuation: "ValuationResult | None" = None,
) -> dict | None:
    """Surface ``final_trade_decision`` as a structured decision event.

    Recognises all five wire ratings (``strong-buy``, ``buy``, ``hold``,
    ``reduce``, ``sell``). Returns ``None`` when nothing changed (or the field
    is empty), letting the caller skip emitting a ``decision`` event.

    ``confidence`` starts as ``None``; :func:`_translate_states` fills it from
    the confidence judge. No role is prompted for a number, so the decision
    text itself never carries a trustworthy one.

    ``rationale`` is the full decision text — the UI renders it as a structured
    report, so we must not clip it (the ``rationale`` column is unlimited
    ``text``).

    When ``valuation`` has a triggered veto, the agent's raw rating is capped
    to the veto's ``rating_cap``. The original rating is preserved under
    ``original_rating`` and the veto metadata is included under ``veto``.
    """
    pdec = prev.get("final_trade_decision") or ""
    cdec = curr.get("final_trade_decision") or ""
    if not cdec or cdec == pdec:
        return None
    owner_verdict = _parse_owner_verdict(cdec)
    rating = _OWNER_VERDICT_RATING[owner_verdict] if owner_verdict else _parse_rating(cdec)
    decision: dict = {
        "rating": rating,
        "confidence": None,
        "rationale": cdec,
    }
    if owner_verdict:
        decision["owner_verdict"] = owner_verdict
    if valuation is not None and valuation.veto.triggered:
        effective, veto = apply_veto(rating, valuation)
        if effective != rating:
            decision["original_rating"] = rating
            decision["rating"] = effective
            decision["veto"] = {"reason": veto.reason, "rating_cap": veto.rating_cap}
    return decision


_DEBATE_STATES = ("investment_debate_state", "risk_debate_state")


def _state_snapshot(state: dict) -> dict:
    """A graph state with the two debate states as plain dicts.

    LangGraph hands over the top level as a dict, in a stream chunk and in a
    checkpoint alike, but the debate states inside it are still upstream's
    ``InvestDebateState`` and ``RiskDebateState`` models. Everything that
    reads a snapshot (the extractors, the confidence judge, the final-state
    record) reads dicts, so the models are converted here and nowhere else.
    """
    return {
        key: value.model_dump() if key in _DEBATE_STATES and isinstance(value, BaseModel) else value
        for key, value in state.items()
    }


def _serialize_final_state(state: dict) -> dict:
    """Flatten the terminal AgentState into a JSON-serializable summary.

    Captures the four analyst reports, both debate histories, the
    synthesised plans and the final decision at run-end; the proxy tee
    stores it on ``agent_runs.final_state`` as the run's audit record.
    """
    out: dict[str, Any] = {}
    for f in (
        "market_report", "sentiment_report", "news_report", "fundamentals_report",
        "investment_plan", "trader_investment_plan", "final_trade_decision",
    ):
        v = state.get(f)
        if v:
            out[f] = v
    inv = state.get("investment_debate_state") or {}
    out["investment_debate_state"] = {
        k: inv.get(k, "") for k in ("bull_history", "bear_history", "judge_decision")
    }
    risk = state.get("risk_debate_state") or {}
    out["risk_debate_state"] = {
        k: risk.get(k, "") for k in (
            "aggressive_history", "conservative_history", "neutral_history",
            "judge_decision",
        )
    }
    return out


@dataclass(frozen=True)
class ValuationOutcome:
    """How the run's valuation went, and what the debate is told about it."""

    # ``multiples_only``: the engine ran but skipped or discarded the DCF.
    status: Literal["ok", "multiples_only", "unavailable"]
    reason: str | None
    result: ValuationResult | None
    summary: str  # agent-facing markdown

    def public(self) -> dict[str, str | None]:
        """The part the stream and the run record carry."""
        return {"status": self.status, "reason": self.reason}


def _valuation_unavailable(reason: str, result: ValuationResult | None = None) -> ValuationOutcome:
    summary = (
        "## Deterministic Valuation\n"
        f"Valuation unavailable for this run: {reason}. No fair value was "
        "computed. Do not cite or invent a DCF target."
    )
    return ValuationOutcome("unavailable", reason, result, summary)


async def _compute_run_valuation(symbol: str, run_id: str | None = None) -> ValuationOutcome:
    """Compute the deterministic valuation for this run.

    A data or compute error is an ``unavailable`` outcome, never an exception:
    a valuation outage must not abort the run, and the debate and the stream
    are told why it is missing.

    A computed result is persisted to ``valuation_snapshots``
    (source='agent_run', linked to ``run_id``) as a record of what the debate
    saw. A failed snapshot does not cost the run its valuation.
    """
    try:
        vi = await fetch_valuation_input(symbol)
        result = value(vi)
    except Exception as e:  # noqa: BLE001 - valuation is best-effort context
        logger.warning("valuation unavailable for %s: %r", symbol, e)
        return _valuation_unavailable((str(e) or type(e).__name__)[:300])
    try:
        await record_valuation_snapshot(result, source="agent_run", run_id=run_id)
    except Exception:  # noqa: BLE001 - snapshot is best-effort
        logger.exception("valuation snapshot failed for %s", symbol)
    if result.data_quality == "unavailable":
        return _valuation_unavailable("market data could not be retrieved", result)
    summary = format_valuation_for_agents(result)
    if result.data_quality == "multiples_only":
        # Every multiples-only path in the engine records why first.
        reason = result.dcf_invalid_reason or next(iter(result.warnings), "no DCF fair value")
        return ValuationOutcome("multiples_only", reason, result, summary)
    return ValuationOutcome("ok", None, result, summary)


class _RunValuation:
    """The run's deterministic valuation, fetched while the analysts work.

    Every debate prompt carries its summary, so the debate waits for it; the
    analysts do not.
    """

    def __init__(
        self, graph: TradingAgentsGraph, symbol: str, run_id: str | None
    ) -> None:
        self.outcome: ValuationOutcome | None = None
        self._context: RunContext = graph.run_context
        self._task = asyncio.ensure_future(_compute_run_valuation(symbol, run_id=run_id))

    @property
    def result(self) -> ValuationResult | None:
        return self.outcome.result if self.outcome else None

    async def settle(self) -> dict | None:
        """Wait for the valuation and put its summary into the run's context.
        Returns the chunk announcing the outcome, the first time only."""
        if self.outcome is not None:
            return None
        self.outcome = await self._task
        self._context.valuation = self.outcome.summary
        return _normalize_chunk(None, {"valuation": self.outcome.public()}, finished=False)

    def cancel(self) -> None:
        self._task.cancel()


def _brief_on_owner(graph: TradingAgentsGraph, symbol: str) -> None:
    """Write who the run is for into its context. The mandate is read here,
    in the run's task, where this run's prompt overrides are set."""
    owner: OwnerContext | None = graph.owner_context
    if owner is None:
        return
    graph.run_context.owner = format_owner_context(owner, symbol)
    graph.run_context.mandate = owner_mandate()


async def run_graph(
    graph: TradingAgentsGraph,
    symbol: str,
    trade_date: date,
    max_debate_rounds: int,
    deep_thinking: bool,
    run_id: str | None = None,
    usage: AsyncCallbackHandler | None = None,
) -> AsyncIterator[dict]:
    """Run the compiled graph and yield normalized chunks.

    ``max_debate_rounds`` and ``deep_thinking`` are accepted for API symmetry
    with the router but are baked into ``graph`` at construction time (see the
    module docstring) — to change them mid-process you must rebuild the graph.

    ``run_id`` (optional) — when set, becomes the LangGraph ``thread_id`` so
    checkpoints written by an attached saver are scoped to this run. Resume
    from a previous checkpoint requires the *same* ``thread_id`` on the same
    saver.

    ``usage`` (optional) — a LangChain :class:`AsyncCallbackHandler` (typically
    :class:`UsageAccumulator`) wired into the graph's ``config['callbacks']``.
    Token usage from every LLM call inside the run accumulates on the handler;
    the router reads ``handler.tokens_in`` / ``handler.tokens_out`` after the
    stream ends to populate the ``run-end`` event.

    After the upstream stream finishes, yields one final chunk with a
    ``final_state`` payload — the captured terminal AgentState the proxy tee
    persists into ``agent_runs.final_state``.
    """
    del max_debate_rounds, deep_thinking  # baked in at build_graph time

    _brief_on_owner(graph, symbol)
    valuation = _RunValuation(graph, symbol, run_id)
    init_state = graph.propagator.create_initial_state(symbol, trade_date.isoformat())
    args = _graph_args(graph, run_id, usage)
    selected = [analyst for analyst in ANALYSTS if analyst.label in graph.graph.nodes]
    try:
        # Every selected analyst starts in the first step, so say so before any
        # of them has a tool call to show.
        for analyst in selected:
            yield _normalize_chunk(analyst.label, {}, finished=False)
        async for chunk in _translate_states(
            graph.graph.astream(init_state, **args), valuation, prev={},
            judge=_confidence_judge(graph, args),
            debate_waits_for=tuple(analyst.report for analyst in selected),
        ):
            yield chunk
    finally:
        valuation.cancel()


async def resume_graph(
    graph: TradingAgentsGraph,
    symbol: str,
    trade_date: date,
    run_id: str,
    usage: AsyncCallbackHandler | None = None,
) -> AsyncIterator[dict]:
    """Continue ``run_id``'s thread from its latest checkpoint.

    Yields the same normalized chunks as :func:`run_graph`. LangGraph's resume
    (``astream(None, ...)``) first re-emits the checkpointed state, so diffing
    starts from that state: only what the resumed steps add is streamed, and
    the final-state chunk still covers the whole run.

    A run that halted with some analysts done reruns only the unfinished ones.
    The valuation is awaited up front here: the checkpoint may sit one step
    before a debate turn. It is computed again, so a resumed run announces it
    a second time.
    """
    _brief_on_owner(graph, symbol)
    valuation = _RunValuation(graph, symbol, run_id)
    announced = await valuation.settle()
    if announced:
        yield announced

    args = _graph_args(graph, run_id, usage)
    checkpoint = await graph.graph.aget_state(args["config"])
    prev = _state_snapshot(checkpoint.values) if checkpoint is not None else {}
    async for chunk in _translate_states(
        graph.graph.astream(None, **args), valuation, prev=prev,
        judge=_confidence_judge(graph, args),
    ):
        yield chunk


def _graph_args(
    graph: TradingAgentsGraph, run_id: str | None, usage: AsyncCallbackHandler | None
) -> dict:
    """The propagator's stream args with our thread_id and usage callback merged
    into its config (which already carries recursion_limit)."""
    args = graph.propagator.get_graph_args()
    existing_config = args.get("config") or {}
    configurable = dict(existing_config.get("configurable") or {})
    if run_id is not None:
        configurable["thread_id"] = run_id
    new_config = {**existing_config, "configurable": configurable}
    if usage is not None:
        new_config["callbacks"] = [*(new_config.get("callbacks") or []), usage]
    return {**args, "config": new_config}


def _confidence_judge(graph: TradingAgentsGraph, args: dict) -> Judge:
    """Bind the judge to the run's deep-think model and config, so its tokens
    land on the same usage callback as the rest of the run."""
    return functools.partial(
        judge_confidence, graph.deep_thinking_llm, config=args["config"]
    )


def _analyst_chunk(analyst: Analyst, prev: dict, curr: dict, reports: list[dict]) -> dict | None:
    """What one analyst did in this step.

    Tool calls are read from the analyst's own conversation, so analysts
    working in the same step never get each other's. The report landing is
    what marks the analyst finished.
    """
    added = _new_messages(prev.get(analyst.channel) or [], curr.get(analyst.channel) or [])
    calls, results = _extract_tool_events(added)
    mine = [r for r in reports if r["node"] == analyst.label]
    values: dict[str, Any] = {}
    if calls:
        values["tool_calls"] = calls
    if results:
        values["tool_results"] = results
    if mine:
        values["reports"] = mine
    if not values:
        return None
    return _normalize_chunk(analyst.label, values, finished=bool(mine))


def _debate_may_be_next(state: dict, debate_waits_for: tuple[str, ...]) -> bool:
    """Whether the graph's next step can be a debate turn: every selected
    analyst has reported, or the debate is already running."""
    turns = (state.get("investment_debate_state") or {}).get("count", 0)
    reported = bool(debate_waits_for) and all(state.get(field) for field in debate_waits_for)
    return reported or turns > 0


async def _translate_states(
    states: AsyncIterator[Any],
    valuation: _RunValuation | None,
    prev: dict,
    judge: Judge | None = None,
    debate_waits_for: tuple[str, ...] = (),
) -> AsyncIterator[dict]:
    """Diff successive AgentState snapshots into normalized chunks, then yield
    the terminal state as a ``final_state`` chunk.

    A snapshot covers one graph step, and several analysts can move in one
    step. Each chunk still names a single node, so a step yields one chunk per
    analyst that moved, then one for the debate stages.
    """
    async for chunk in states:
        curr = _state_snapshot(chunk)

        reports = _extract_reports(prev, curr)
        for analyst in ANALYSTS:
            analyst_chunk = _analyst_chunk(analyst, prev, curr, reports)
            if analyst_chunk:
                yield analyst_chunk

        node = _detect_node(prev, curr)
        values: dict[str, Any] = {}
        debate = _extract_debate(prev, curr)
        if debate:
            values["debate"] = debate
        risk_debate = _extract_risk_debate(prev, curr)
        if risk_debate:
            values["risk_debate"] = risk_debate
        synthesis = _extract_synthesis(prev, curr)
        if synthesis:
            values["synthesis"] = synthesis
        decision = _extract_decision(
            prev, curr, valuation=valuation.result if valuation else None
        )
        if decision:
            if judge is not None:
                decision["confidence"] = await judge(curr, decision["rating"])
            values["decision"] = decision
            if decision.get("veto"):
                values["valuation_veto"] = {
                    "original_rating": decision["original_rating"],
                    "effective_rating": decision["rating"],
                    **decision["veto"],
                }

        if values or node:
            # A stage is named by the field it wrote, so naming it means it is done.
            yield _normalize_chunk(node, values, finished=node is not None)

        # The graph only takes its next step when this loop asks for the next
        # snapshot, so waiting here puts the valuation into the context before
        # the first debate prompt is built.
        if valuation is not None and _debate_may_be_next(curr, debate_waits_for):
            announced = await valuation.settle()
            if announced:
                yield announced

        prev = curr

    # End of stream — yield the captured terminal AgentState so the proxy
    # tee can persist it on agent_runs.final_state.
    if prev:
        snapshot = _serialize_final_state(prev)
        if valuation is not None and valuation.outcome is not None:
            snapshot["valuation"] = valuation.outcome.public()
        if snapshot:
            yield _normalize_chunk(None, {"final_state": snapshot}, finished=False)
