"""TradingAgents LangGraph wiring + stream adapter.

Investigation findings (tradingagents 0.2.4, the version pinned in
``pyproject.toml``):

1. There is **no** ``tradingagents.default_config`` module — the plan's
   ``from tradingagents.default_config import DEFAULT_CONFIG`` would fail.
   Configuration is a typed pydantic model: :class:`tradingagents.config.TradingAgentsConfig`
   with required fields ``llm_provider``, ``deep_think_llm``, ``quick_think_llm``,
   ``max_debate_rounds``, ``max_risk_discuss_rounds``, ``max_recur_limit``.
2. :class:`tradingagents.graph.trading_graph.TradingAgentsGraph` does **not**
   accept a ``toolkit`` kwarg. Tools are imported as module-level globals from
   ``tradingagents.agents.utils.agent_utils`` by ``graph/setup.py`` and bound to
   ``ToolNode`` inside the graph builder. Wiring our own toolkit therefore
   requires monkey-patching those module attributes before graph compilation.
3. The compiled DAG lives at ``graph_obj.graph`` (a ``CompiledStateGraph``),
   which is a ``cached_property`` — accessing it triggers compilation and
   freezes ``max_debate_rounds`` (it is read once at compile time inside
   :class:`tradingagents.graph.conditional_logic.ConditionalLogic`). Mutating
   ``cfg["max_debate_rounds"]`` after construction is a no-op for the running
   graph; per-run overrides must be passed to :func:`build_graph`.
4. The stream method is ``graph_obj.graph.astream(state, **graph_args)`` where
   ``graph_args = {"stream_mode": "values", "config": {"recursion_limit": N}}``.
   Each chunk is a dict-shaped ``AgentState`` snapshot (full state after the
   node that just ran), keyed by ``messages``, ``market_report``,
   ``investment_debate_state``, ``risk_debate_state``, ``final_trade_decision``,
   etc. There is **no** ``metadata.langgraph_node`` in this mode.
5. ``state.messages`` are langchain ``BaseMessage`` subclasses (``AIMessage``,
   ``ToolMessage``, ``HumanMessage``); tool calls live on ``AIMessage.tool_calls``
   and tool results arrive as ``ToolMessage`` instances.

Adaptations made here:

- ``build_graph`` constructs a :class:`TradingAgentsConfig` (no DEFAULT_CONFIG).
- The toolkit is wired by monkey-patching ``tradingagents.agents.utils.agent_utils``
  so the graph picks up our HTTP-backed tools when its setup module imports them.
- ``run_graph`` diffs successive AgentState snapshots and translates them into
  the **normalized** chunk shape :func:`app.services.agents.streaming.translate_chunks`
  expects. Stream-tool-call/-result pairs come from inspecting message deltas;
  debate rounds and decisions come from observing changes to
  ``investment_debate_state`` and ``final_trade_decision``.

Checkpointing (Task 8):

- :class:`TradingAgentsGraph.graph` compiles the workflow with **no**
  checkpointer (``setup_graph`` calls ``workflow.compile()`` with no args).
  We can't pass one through the constructor.
- The ``CompiledStateGraph`` returned exposes a ``builder`` attribute holding
  the original :class:`StateGraph`. To wire a checkpointer we therefore
  *recompile*: read ``ta.graph.builder``, call
  ``builder.compile(checkpointer=saver)``, and reassign the result onto
  ``ta.graph`` (overriding the ``cached_property``).
- The saver itself is shared across runs — it is owned by the FastAPI
  lifespan and lives on ``app.state.checkpointer``. ``run_graph`` only needs
  to thread the per-run ``thread_id`` (== our ``run_id``) into the LangGraph
  config so checkpoints associate with the right conversation.
- ``app.state.checkpointer`` is ``None`` when ``DATABASE_URL`` isn't set
  (unit tests, dev without DB) — :func:`attach_checkpointer` is a no-op in
  that case so existing tests stay green.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, AsyncIterator

from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from tradingagents.agents.utils import agent_utils as _agent_utils
from tradingagents.config import TradingAgentsConfig
from tradingagents.graph.trading_graph import TradingAgentsGraph

from .model_config import build_tradingagents_config
from .toolkit import AgentToolkit, OpenDClient, build_toolkit


# Names on tradingagents.agents.utils.agent_utils we override with our toolkit.
_TOOLKIT_ATTRS = (
    "get_stock_data",
    "get_indicators",
    "get_fundamentals",
    "get_balance_sheet",
    "get_cashflow",
    "get_income_statement",
    "get_insider_transactions",
    "get_news",
    "get_global_news",
)


def _install_toolkit(toolkit: AgentToolkit) -> None:
    """Replace the tradingagents-bundled tools with our HTTP-backed ones.

    Setup of the LangGraph DAG (``graph/setup.py`` -> ``graph/trading_graph.py``)
    imports tools by name from ``tradingagents.agents.utils.agent_utils``; if we
    swap those module globals before the cached ``graph`` property is touched,
    the compiled DAG binds to our tools instead.
    """
    for attr in _TOOLKIT_ATTRS:
        setattr(_agent_utils, attr, getattr(toolkit, attr))


def build_graph(
    opend_client: OpenDClient | None,
    *,
    max_debate_rounds: int = 1,
    deep_thinking: bool = True,
    results_dir: Path | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> TradingAgentsGraph:
    """Construct a TradingAgentsGraph wired to our toolkit and config.

    ``deep_thinking`` toggles which model tier the analysts use; in
    tradingagents v0.2.4 this is captured by ``reasoning_effort`` (the
    ``use_deep_thinking_for_analysts`` flag the plan referenced is not part of
    the public config). ``deep_thinking=True`` -> ``"medium"``; False ->
    ``"minimal"`` (faster, cheaper).

    ``checkpointer`` (optional) — recompile the underlying StateGraph with a
    checkpoint saver attached. See :func:`attach_checkpointer`. Pass ``None``
    to keep TradingAgents' default (no checkpointing) — that's the unit-test
    path and the only path before Task 8 wiring lands at startup.
    """
    raw = build_tradingagents_config()
    cfg = TradingAgentsConfig(
        llm_provider=raw["llm_provider"],
        deep_think_llm=raw["deep_think_llm"],
        quick_think_llm=raw["quick_think_llm"],
        reasoning_effort="medium" if deep_thinking else "minimal",
        max_debate_rounds=max_debate_rounds,
        max_risk_discuss_rounds=max_debate_rounds,
        max_recur_limit=100,
        results_dir=results_dir or Path("./results"),
    )
    toolkit = build_toolkit(opend_client)
    _install_toolkit(toolkit)
    ta = TradingAgentsGraph(config=cfg, debug=False)
    if checkpointer is not None:
        attach_checkpointer(ta, checkpointer)
    return ta


def attach_checkpointer(
    ta: TradingAgentsGraph, saver: BaseCheckpointSaver
) -> None:
    """Recompile ``ta.graph`` with ``saver`` wired in.

    ``TradingAgentsGraph.graph`` is a :class:`functools.cached_property` that
    computes a :class:`langgraph.graph.state.CompiledStateGraph`. The compiled
    object exposes its source :class:`langgraph.graph.state.StateGraph` via
    the ``builder`` attribute. We re-call ``builder.compile(checkpointer=...)``
    to get a fresh compiled graph bound to our saver, then assign it to
    ``ta.graph`` (overriding the cached_property descriptor by writing the
    instance dict, which Python prefers over the descriptor on read).

    The result: every ``ta.graph.astream(state, config=...)`` call now writes
    checkpoints to the saver, and ``astream(None, config=...)`` resumes from
    the latest checkpoint for the matching ``thread_id``.
    """
    compiled = ta.graph  # triggers initial compile via cached_property
    builder = compiled.builder
    ta.graph = builder.compile(checkpointer=saver)  # type: ignore[misc]


def _normalize_chunk(node: str | None, values: dict[str, Any], finished: bool) -> dict:
    """Wrap a per-step delta in our normalized chunk shape."""
    return {
        "metadata": {"langgraph_node": node, "node_finished": finished},
        "values": values,
    }


# AgentState fields that look like "Analyst <X> just produced a report".
# Used to attribute tool-call/result deltas to a sensible node name.
_REPORT_NODE_MAP = {
    "market_report": "Market Analyst",
    "sentiment_report": "Social Analyst",
    "news_report": "News Analyst",
    "fundamentals_report": "Fundamentals Analyst",
    "investment_plan": "Research Manager",
    "trader_investment_plan": "Trader",
    "final_trade_decision": "Risk Manager",
}


def _detect_node(prev: dict, curr: dict) -> str | None:
    """Pick a node label by spotting which AgentState field changed."""
    for field, label in _REPORT_NODE_MAP.items():
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
    pdb = (prev.get("investment_debate_state") or {}) if isinstance(prev.get("investment_debate_state"), dict) else {}
    cdb = (curr.get("investment_debate_state") or {}) if isinstance(curr.get("investment_debate_state"), dict) else {}
    pcount = pdb.get("count", 0)
    ccount = cdb.get("count", 0)
    if ccount <= pcount:
        return None
    text = cdb.get("current_response", "") or ""
    # Bull turns are the odd-numbered counts (1, 3, ...) under tradingagents'
    # bull-first ordering; even-numbered are bear.
    side = "bull" if ccount % 2 == 1 else "bear"
    return {"round": (ccount + 1) // 2, "side": side, "text": text}


def _extract_decision(prev: dict, curr: dict) -> dict | None:
    """Surface ``final_trade_decision`` as a structured decision event."""
    pdec = prev.get("final_trade_decision") or ""
    cdec = curr.get("final_trade_decision") or ""
    if not cdec or cdec == pdec:
        return None
    rating = "hold"
    upper = cdec.upper()
    if "BUY" in upper:
        rating = "buy"
    elif "SELL" in upper:
        rating = "sell"
    return {"rating": rating, "confidence": None, "rationale": cdec[:500]}


def _state_snapshot(state: Any) -> dict:
    """Coerce a stream chunk into a plain dict for diffing.

    AgentState chunks are normally dicts in ``stream_mode="values"`` but some
    LangGraph paths return pydantic models — handle both.
    """
    if isinstance(state, dict):
        return state
    if hasattr(state, "model_dump"):
        return state.model_dump()
    return dict(state) if state else {}


def _format_memory_situation(symbol: str, row: dict) -> str:
    """Build the BM25 lookup key for a past reflection.

    The trader's runtime ``curr_situation`` is the concatenation of the four
    analyst reports for the current date, so to give past reflections a chance
    of matching we lead the situation text with the symbol — analyst reports
    routinely mention the company name and ticker. Outcome and rating give the
    BM25 scorer extra terms when the trader's situation is dominated by
    market commentary.
    """
    rating = row.get("rating") or "?"
    outcome = row.get("outcome") or "?"
    td = row.get("trade_date")
    return f"{symbol} {rating} {outcome} on {td}"


def _format_memory_recommendation(row: dict) -> str:
    """Build the human-readable recommendation injected into the trader prompt.

    Whatever string we return here is concatenated verbatim into
    ``past_memory_str`` (see ``tradingagents.agents.trader.trader``) which is
    formatted into the trader system prompt's ``{past_memory_str}`` slot.
    Keeping each line short and parseable matters more than prose.
    """
    rating = row.get("rating") or "?"
    outcome = row.get("outcome") or "?"
    alpha = row.get("alpha")
    text = row.get("text") or ""
    alpha_str = f"{alpha:+.2%}" if isinstance(alpha, (int, float)) else "n/a"
    return f"Past {rating} -> alpha {alpha_str}, outcome {outcome}: {text}"


def _seed_trader_memory(
    graph: TradingAgentsGraph, symbol: str, memory: list[dict]
) -> None:
    """Seed the trader's BM25 memory with prior reflections.

    Tradingagents v0.2.4 already exposes a per-agent
    :class:`FinancialSituationMemory` (BM25 over situation/recommendation
    pairs) that the trader node consults in its prompt construction. We
    reuse that surface — ``graph.trader_memory`` is a ``cached_property``,
    so seeding it here mutates the same instance the trader node reads
    later, with no monkey-patching required. ``graph.graph`` (cached
    property that compiles the DAG) must not have been accessed yet for
    other reasons, but it isn't a precondition for this seeding step:
    seeding before *or* after compile is fine because the trader resolves
    its memory by reference at call time.
    """
    if not memory:
        return
    pairs: list[tuple[str, str]] = [
        (_format_memory_situation(symbol, row), _format_memory_recommendation(row))
        for row in memory
    ]
    graph.trader_memory.add_situations(pairs)


async def run_graph(
    graph: TradingAgentsGraph,
    symbol: str,
    trade_date: date,
    max_debate_rounds: int,
    deep_thinking: bool,
    memory: list[dict] | None = None,
    run_id: str | None = None,
) -> AsyncIterator[dict]:
    """Run the compiled graph and yield normalized chunks.

    ``max_debate_rounds`` and ``deep_thinking`` are accepted for API symmetry
    with the router but are baked into ``graph`` at construction time (see the
    module docstring) — to change them mid-process you must rebuild the graph.

    ``memory`` is the list of prior reflections returned by
    :class:`app.services.agents.memory.PostgresMemoryProvider.recall`. When
    non-empty, those rows are seeded into the trader's
    :class:`FinancialSituationMemory` so the trader's existing prompt-time
    BM25 lookup picks them up. ``None`` / ``[]`` is a no-op — runs without
    memory are unchanged.

    ``run_id`` (optional) — when set, becomes the LangGraph ``thread_id`` so
    checkpoints written by an attached saver are scoped to this run. Resume
    from a previous checkpoint requires the *same* ``thread_id`` on the same
    saver.
    """
    del max_debate_rounds, deep_thinking  # baked in at build_graph time

    _seed_trader_memory(graph, symbol, memory or [])

    init_state = graph.propagator.create_initial_state(symbol, trade_date.isoformat())
    args = graph.propagator.get_graph_args()
    if run_id is not None:
        # Merge our thread_id into the propagator's config (which already
        # carries recursion_limit, etc) without losing the propagator's
        # fields.
        existing_config = args.get("config") or {}
        configurable = dict(existing_config.get("configurable") or {})
        configurable["thread_id"] = run_id
        args = {**args, "config": {**existing_config, "configurable": configurable}}

    prev: dict = {}
    async for chunk in graph.graph.astream(init_state, **args):
        curr = _state_snapshot(chunk)
        node = _detect_node(prev, curr)

        prev_msgs = prev.get("messages") or []
        curr_msgs = curr.get("messages") or []
        added = _new_messages(prev_msgs, curr_msgs)
        calls, results = _extract_tool_events(added)

        values: dict[str, Any] = {}
        if calls:
            values["tool_calls"] = calls
        if results:
            values["tool_results"] = results
        debate = _extract_debate(prev, curr)
        if debate:
            values["debate"] = debate
        decision = _extract_decision(prev, curr)
        if decision:
            values["decision"] = decision

        finished = bool(node and (calls or results or debate or decision or _detect_node(prev, curr)))
        if values or node:
            yield _normalize_chunk(node, values, finished=finished)

        prev = curr
