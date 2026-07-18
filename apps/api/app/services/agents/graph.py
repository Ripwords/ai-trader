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

import asyncio
import re
from datetime import date
from pathlib import Path
from typing import Any, AsyncIterator

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.checkpoint.base import BaseCheckpointSaver
from tradingagents.agents.utils import agent_utils as _agent_utils
from tradingagents.config import TradingAgentsConfig
from tradingagents.graph.trading_graph import TradingAgentsGraph

from .model_config import build_tradingagents_config
from .toolkit import AgentToolkit, OpenDClient, build_toolkit
from app.services.valuation.compose import apply_veto, value
from app.services.valuation.fetch import fetch_valuation_input
from app.services.valuation.models import ValuationResult
from app.services.valuation.persist import record_valuation_snapshot
from app.services.valuation.summary import format_valuation_for_agents


# ``build_graph`` mutates module globals on ``tradingagents.agents.utils.agent_utils``
# (it monkey-patches in our HTTP-backed toolkit, which the compiled graph
# binds to during setup). Two concurrent calls would race on those globals.
# This module-level lock serialises every ``build_graph_locked`` call so the
# critical section (``_install_toolkit`` -> ``TradingAgentsGraph(...)`` ->
# accessing ``ta.graph``) is always single-threaded.
_build_lock = asyncio.Lock()


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

    Patching only ``agent_utils`` is NOT sufficient. ``trading_graph.py`` does:

        from tradingagents.agents.utils.agent_utils import (
            get_stock_data, get_news, get_balance_sheet, ...
        )

    at module load time, which COPIES function-object references into
    ``trading_graph``'s namespace. ``ToolNode([get_stock_data, ...])`` then
    binds to those copies, not to the live ``agent_utils`` attribute. Patching
    ``agent_utils`` after the import is a no-op for the compiled DAG.

    To make the swap stick, we patch BOTH modules — ``agent_utils`` for any
    code path that does ``getattr(agent_utils, ...)`` lookup at runtime, and
    ``trading_graph`` so the eager-imported references in its namespace point
    at our toolkit when ``ToolNode`` is constructed (at compile time, inside
    the cached_property accessor that fires after this function returns).
    """
    from tradingagents.graph import trading_graph as _trading_graph

    for attr in _TOOLKIT_ATTRS:
        replacement = getattr(toolkit, attr)
        setattr(_agent_utils, attr, replacement)
        setattr(_trading_graph, attr, replacement)


def build_graph(
    opend_client: OpenDClient | None,
    *,
    max_debate_rounds: int = 1,
    max_risk_discuss_rounds: int = 1,
    deep_thinking: bool = True,
    reasoning_effort: str = "medium",
    response_language: str = "en-US",
    selected_analysts: list[str] | None = None,
    company_name: str | None = None,
    results_dir: Path | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> TradingAgentsGraph:
    """Construct a TradingAgentsGraph wired to our toolkit and config.

    ``deep_thinking`` is layered on top of ``reasoning_effort``: when False
    we override whatever effort was passed to ``"minimal"`` so a single
    cheap+fast pass runs even if the caller forgot to lower the effort.
    Otherwise ``reasoning_effort`` is honoured verbatim
    (``low|medium|high|xhigh|max``) and mapped to the provider-native knob
    inside TradingAgents' ``build_chat_model``.

    ``selected_analysts`` chooses which of the four analyst nodes
    (``market``/``social``/``news``/``fundamentals``) actually run. Skipping
    ``social`` typically saves ~20% of the LLM cost on a run; skipping
    ``news`` saves another ~15%. ``None`` defaults to all four.

    ``checkpointer`` (optional) — recompile the underlying StateGraph with a
    checkpoint saver attached. See :func:`attach_checkpointer`. Pass ``None``
    to keep TradingAgents' default (no checkpointing).
    """
    effort = "minimal" if not deep_thinking else reasoning_effort
    raw = build_tradingagents_config(
        reasoning_effort=effort,
        response_language=response_language,
    )
    cfg = TradingAgentsConfig(
        llm_provider=raw["llm_provider"],
        deep_think_llm=raw["deep_think_llm"],
        quick_think_llm=raw["quick_think_llm"],
        reasoning_effort=effort,
        response_language=response_language,
        max_debate_rounds=max_debate_rounds,
        max_risk_discuss_rounds=max_risk_discuss_rounds,
        max_recur_limit=100,
        results_dir=results_dir or Path("./results"),
    )
    toolkit = build_toolkit(opend_client, company_name=company_name)
    _install_toolkit(toolkit)
    # ``selected_analysts`` is forwarded to ``GraphSetup`` via the kwarg of
    # the same name; defaults are TradingAgents' four analysts.
    ta_kwargs: dict[str, Any] = {"config": cfg, "debug": False}
    if selected_analysts is not None:
        ta_kwargs["selected_analysts"] = selected_analysts
    ta = TradingAgentsGraph(**ta_kwargs)
    # Touch ``ta.graph`` (a cached_property) inside the build path so the
    # compile step — which reads the toolkit globals we just installed — runs
    # before another concurrent caller can monkey-patch them with a different
    # toolkit. ``attach_checkpointer`` already triggers the same compile, so
    # only force it when no checkpointer is wired.
    if checkpointer is not None:
        attach_checkpointer(ta, checkpointer)
    else:
        _ = ta.graph
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
    results_dir: Path | None = None,
    checkpointer: BaseCheckpointSaver | None = None,
) -> TradingAgentsGraph:
    """Async wrapper around :func:`build_graph` that holds :data:`_build_lock`.

    Use this from request handlers; the lock guarantees that the toolkit
    monkey-patch + graph compile are not racing across concurrent runs. The
    underlying :func:`build_graph` is sync, so we run it on a worker thread
    via :func:`asyncio.to_thread` to keep the event loop responsive while
    LangGraph's compile step runs (it can be O(100 ms) on a cold path).
    """
    # We resolve ``build_graph`` lazily off the module so tests can patch it
    # via ``monkeypatch.setattr(graph_mod, "build_graph", ...)`` without
    # losing the lock semantics they're trying to verify.
    import sys

    async with _build_lock:
        target = getattr(sys.modules[__name__], "build_graph")
        return await asyncio.to_thread(
            target,
            opend_client,
            max_debate_rounds=max_debate_rounds,
            max_risk_discuss_rounds=max_risk_discuss_rounds,
            deep_thinking=deep_thinking,
            reasoning_effort=reasoning_effort,
            response_language=response_language,
            selected_analysts=selected_analysts,
            company_name=company_name,
            results_dir=results_dir,
            checkpointer=checkpointer,
        )


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


# Map a tool name back to the analyst likely calling it. We use this when an
# analyst is mid-execution (calling tools but hasn't finished its report yet)
# so we can emit a ``node-start`` event early instead of leaving the UI silent
# for the 15-30s it takes the first analyst to finish a report. Order doesn't
# matter; each tool maps to exactly one analyst by design.
_TOOL_TO_NODE = {
    "get_balance_sheet": "Fundamentals Analyst",
    "get_cashflow": "Fundamentals Analyst",
    "get_income_statement": "Fundamentals Analyst",
    "get_fundamentals": "Fundamentals Analyst",
    "get_insider_transactions": "Fundamentals Analyst",
    "get_news": "News Analyst",
    "get_global_news": "News Analyst",
    "get_stock_data": "Market Analyst",
    "get_indicators": "Market Analyst",
}


def _detect_node(prev: dict, curr: dict) -> str | None:
    """Pick a node label by spotting which AgentState field changed."""
    for field, label in _REPORT_NODE_MAP.items():
        if (curr.get(field) or "") != (prev.get(field) or ""):
            return label
    return None


def _infer_node_from_tools(
    calls: list[dict], results: list[dict]
) -> str | None:
    """Infer which analyst is running based on the tool name in flight.

    A report-field change marks "analyst finished"; before that, the only
    signal we have is which tool just got called. Mapping tool name -> analyst
    lets the UI render a 'X Analyst (working...)' card the moment the first
    tool call lands rather than waiting for the report to finalise.
    """
    for tc in calls:
        node = _TOOL_TO_NODE.get(tc.get("name") or "")
        if node:
            return node
    for tr in results:
        node = _TOOL_TO_NODE.get(tr.get("name") or "")
        if node:
            return node
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


# Map ``*_report`` AgentState field → (kind tag, analyst label). The tag is
# what the UI uses to colour-code / route the report; the label matches the
# ``node`` we already emit elsewhere so the report can be attached to the
# right step card.
_REPORT_KIND_MAP: tuple[tuple[str, str, str], ...] = (
    ("market_report",       "market",       "Market Analyst"),
    ("sentiment_report",    "sentiment",    "Social Analyst"),
    ("news_report",         "news",         "News Analyst"),
    ("fundamentals_report", "fundamentals", "Fundamentals Analyst"),
)


def _extract_reports(prev: dict, curr: dict) -> list[dict]:
    """Return one entry per analyst report that just landed.

    TradingAgents writes each analyst's full markdown report into its own
    AgentState field at the end of that node's run. Earlier we only surfaced
    a 500-char ``summary`` truncation in ``node-end`` — the bulk of the
    pipeline's output never reached the UI. Now we emit a separate ``report``
    event with the full markdown so the UI can render each analyst's full
    research note.
    """
    out: list[dict] = []
    for field, kind, node in _REPORT_KIND_MAP:
        pval = prev.get(field) or ""
        cval = curr.get(field) or ""
        if cval and cval != pval:
            out.append({"kind": kind, "node": node, "content": cval})
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
    # The Research Manager's ``judge_decision`` on the bull/bear debate is
    # also a distinct artifact — closing argument for the investment debate
    # before the Trader picks it up.
    pdb = prev.get("investment_debate_state") or {}
    cdb = curr.get("investment_debate_state") or {}
    if isinstance(pdb, dict) and isinstance(cdb, dict):
        pj = pdb.get("judge_decision") or ""
        cj = cdb.get("judge_decision") or ""
        if cj and cj != pj:
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
    if not (isinstance(pdb, dict) and isinstance(cdb, dict)):
        return None
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

# Confidence/conviction is reported in several shapes — ``confidence: 85``,
# ``confidence 72%``, ``conviction of 60%``, or ``80% conviction``. Accept the
# number on either side of the keyword. The unsigned ``\d`` naturally drops a
# leading ``-`` (so ``-5`` is read as ``5``, then clamped to 0).
_CONFIDENCE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?:confidence|conviction)\b[^\d%]{0,12}(\d{1,3})\s*%?", re.IGNORECASE),
    re.compile(r"(\d{1,3})\s*%\s*(?:confidence|conviction)", re.IGNORECASE),
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
    """
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


def _parse_confidence(text: str) -> int | None:
    """Extract an integer confidence in [0, 100], or ``None`` when absent.

    The Risk Manager is never *prompted* for a confidence number, so most
    runs won't contain one. Returning ``None`` (rather than a fabricated
    default) lets the UI show a qualitative conviction band instead of a
    misleading flat ``50%``. The persistence boundary (the web tee writer)
    coerces ``None`` to the neutral 50 to satisfy the ``NOT NULL`` column.
    """
    for pattern in _CONFIDENCE_PATTERNS:
        m = pattern.search(text)
        if m:
            return max(0, min(100, int(m.group(1))))
    return None


def _extract_decision(
    prev: dict,
    curr: dict,
    valuation: "ValuationResult | None" = None,
) -> dict | None:
    """Surface ``final_trade_decision`` as a structured decision event.

    Recognises all five wire ratings (``strong-buy``, ``buy``, ``hold``,
    ``reduce``, ``sell``) and parses an optional confidence number from
    the decision text. Returns ``None`` when nothing changed (or the field
    is empty), letting the caller skip emitting a ``decision`` event.

    ``confidence`` is ``int | None`` — ``None`` when the model gave no number.
    The tee writer coerces ``None`` to the neutral 50 at the ``NOT NULL``
    ``agent_decisions.confidence`` boundary; the streamed event keeps ``None``
    so the UI can show a qualitative band rather than a fabricated percentage.

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
    rating = _parse_rating(cdec)
    decision: dict = {
        "rating": rating,
        "confidence": _parse_confidence(cdec),
        "rationale": cdec,
    }
    if valuation is not None and valuation.veto.triggered:
        effective, veto = apply_veto(rating, valuation)
        if effective != rating:
            decision["original_rating"] = rating
            decision["rating"] = effective
            decision["veto"] = {"reason": veto.reason, "rating_cap": veto.rating_cap}
    return decision


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
    """Seed the trader's BM25 memory with prior reflections (legacy path).

    Kept for callers that pass a flat list. New callers should use
    :func:`_seed_all_memories` so each role gets its own slice.
    """
    if not memory:
        return
    pairs: list[tuple[str, str]] = [
        (_format_memory_situation(symbol, row), _format_memory_recommendation(row))
        for row in memory
    ]
    graph.trader_memory.add_situations(pairs)


# Map our reflection ``role`` strings to the matching ``cached_property`` on
# ``TradingAgentsGraph``. Each property exposes a ``FinancialSituationMemory``
# we mutate in place so the corresponding agent node picks the lesson up at
# prompt-construction time. ``overall`` is fanned out to the trader since
# legacy single-row reflections were trader-flavoured.
_ROLE_MEMORY_ATTR: dict[str, str] = {
    "trader":          "trader_memory",
    "bull_researcher": "bull_memory",
    "bear_researcher": "bear_memory",
    "invest_judge":    "invest_judge_memory",
    "risk_manager":    "risk_manager_memory",
    "overall":         "trader_memory",
}


def _seed_all_memories(
    graph: TradingAgentsGraph,
    symbol: str,
    memory_by_role: dict[str, list[dict]],
) -> None:
    """Seed each per-role :class:`FinancialSituationMemory` from its slice.

    TradingAgents instantiates five separate memory pools — one each for
    bull/bear researchers, the trader, the investment judge (Research
    Manager), and the risk manager. The Reflector writes lessons into each
    pool keyed to that role's specific slip-ups; seeding them all here means
    the bull researcher can learn that "I overweighted insider buys last
    quarter" without that lesson contaminating the bear's prompt context.
    Each pool is a BM25 over (situation, recommendation) pairs the agent
    node consults at prompt time.
    """
    for role, rows in memory_by_role.items():
        if not rows:
            continue
        attr = _ROLE_MEMORY_ATTR.get(role)
        if attr is None:
            continue
        target = getattr(graph, attr, None)
        if target is None:
            continue
        pairs: list[tuple[str, str]] = [
            (_format_memory_situation(symbol, row), _format_memory_recommendation(row))
            for row in rows
        ]
        target.add_situations(pairs)


def _serialize_final_state(state: dict) -> dict:
    """Flatten the terminal AgentState into a JSON-serializable summary.

    Reflection runs hours after the run completed and needs the same inputs
    TradingAgents' Reflector reads — the four analyst reports, both debate
    histories, the synthesised plans, the final decision — to write
    role-specific lessons. We capture them at run-end so the reflection job
    doesn't have to re-walk the agent_messages stream.
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
    if isinstance(inv, dict):
        out["investment_debate_state"] = {
            k: inv.get(k, "") for k in ("bull_history", "bear_history", "judge_decision")
        }
    risk = state.get("risk_debate_state") or {}
    if isinstance(risk, dict):
        out["risk_debate_state"] = {
            k: risk.get(k, "") for k in (
                "aggressive_history", "conservative_history", "neutral_history",
                "judge_decision",
            )
        }
    return out


async def _compute_run_valuation(
    symbol: str, run_id: str | None = None
) -> tuple[ValuationResult | None, str]:
    """Compute the deterministic valuation for this run, fail-soft.

    Returns (result, agent-facing summary markdown). Any data/compute error
    returns (None, "") so a valuation outage never aborts the agent run.

    On success the result is persisted to ``valuation_snapshots``
    (source='agent_run', linked to ``run_id``) so the reflection job can
    later compare the DCF fair value against the realized price. The
    persist call is best-effort and separately guarded — even a raising
    recorder must not kill the run's valuation context.
    """
    try:
        vi = await fetch_valuation_input(symbol)
        result = value(vi)
    except Exception as e:  # noqa: BLE001 - valuation is best-effort context
        print(f"[agents] valuation skipped for {symbol}: {e}")
        return None, ""
    try:
        await record_valuation_snapshot(result, source="agent_run", run_id=run_id)
    except Exception as e:  # noqa: BLE001 - snapshot is best-effort
        print(f"[agents] valuation snapshot failed for {symbol}: {e}")
    return result, format_valuation_for_agents(result)


async def run_graph(
    graph: TradingAgentsGraph,
    symbol: str,
    trade_date: date,
    max_debate_rounds: int,
    deep_thinking: bool,
    memory: list[dict] | None = None,
    memory_by_role: dict[str, list[dict]] | None = None,
    run_id: str | None = None,
    usage: AsyncCallbackHandler | None = None,
) -> AsyncIterator[dict]:
    """Run the compiled graph and yield normalized chunks.

    ``max_debate_rounds`` and ``deep_thinking`` are accepted for API symmetry
    with the router but are baked into ``graph`` at construction time (see the
    module docstring) — to change them mid-process you must rebuild the graph.

    ``memory`` is the legacy flat-list of trader reflections; deprecated in
    favour of ``memory_by_role`` which carries one slice per role
    (``trader``, ``bull_researcher``, ``bear_researcher``, ``invest_judge``,
    ``risk_manager``). When both are provided, ``memory_by_role`` wins.

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
    persists into ``agent_runs.final_state`` for the per-role reflection job
    to read later.
    """
    del max_debate_rounds, deep_thinking  # baked in at build_graph time

    if memory_by_role:
        _seed_all_memories(graph, symbol, memory_by_role)
    else:
        _seed_trader_memory(graph, symbol, memory or [])

    run_valuation, valuation_summary = await _compute_run_valuation(symbol, run_id=run_id)
    if valuation_summary:
        _seed_all_memories(graph, symbol, {
            "invest_judge": [{"text": valuation_summary, "rating": "valuation",
                              "outcome": "context", "trade_date": trade_date.isoformat()}],
            "risk_manager": [{"text": valuation_summary, "rating": "valuation",
                              "outcome": "context", "trade_date": trade_date.isoformat()}],
        })

    init_state = graph.propagator.create_initial_state(symbol, trade_date.isoformat())
    args = graph.propagator.get_graph_args()
    if run_id is not None or usage is not None:
        # Merge our thread_id and/or callback into the propagator's config
        # (which already carries recursion_limit, etc) without losing the
        # propagator's fields.
        existing_config = args.get("config") or {}
        configurable = dict(existing_config.get("configurable") or {})
        if run_id is not None:
            configurable["thread_id"] = run_id
        new_config = {**existing_config, "configurable": configurable}
        if usage is not None:
            existing_callbacks = list(new_config.get("callbacks") or [])
            existing_callbacks.append(usage)
            new_config["callbacks"] = existing_callbacks
        args = {**args, "config": new_config}

    prev: dict = {}
    async for chunk in graph.graph.astream(init_state, **args):
        curr = _state_snapshot(chunk)
        # ``node`` from a report-field change means "this analyst just finished".
        # We mark such chunks ``node_finished=True`` so the UI flips the card to
        # done. Mid-run chunks (tool call/result) get ``node`` from
        # ``_infer_node_from_tools`` so the card *appears* early — the user sees
        # 'Fundamentals Analyst (working...)' as soon as the first
        # get_balance_sheet call fires, instead of staring at "running..." until
        # the report finalises 15-30s later.
        finished_node = _detect_node(prev, curr)

        prev_msgs = prev.get("messages") or []
        curr_msgs = curr.get("messages") or []
        added = _new_messages(prev_msgs, curr_msgs)
        calls, results = _extract_tool_events(added)

        node = finished_node or _infer_node_from_tools(calls, results)

        values: dict[str, Any] = {}
        if calls:
            values["tool_calls"] = calls
        if results:
            values["tool_results"] = results
        debate = _extract_debate(prev, curr)
        if debate:
            values["debate"] = debate
        risk_debate = _extract_risk_debate(prev, curr)
        if risk_debate:
            values["risk_debate"] = risk_debate
        reports = _extract_reports(prev, curr)
        if reports:
            values["reports"] = reports
        synthesis = _extract_synthesis(prev, curr)
        if synthesis:
            values["synthesis"] = synthesis
        decision = _extract_decision(prev, curr, valuation=run_valuation)
        if decision:
            values["decision"] = decision
            if decision.get("veto"):
                values["valuation_veto"] = {
                    "original_rating": decision["original_rating"],
                    "effective_rating": decision["rating"],
                    **decision["veto"],
                }

        finished = bool(finished_node and (calls or results or debate or decision or reports))
        if values or node:
            yield _normalize_chunk(node, values, finished=finished)

        prev = curr

    # End of stream — yield the captured terminal AgentState so the proxy
    # tee can persist it on agent_runs.final_state. The reflection job reads
    # it later to drive role-specific lessons.
    if prev:
        snapshot = _serialize_final_state(prev)
        if snapshot:
            yield _normalize_chunk(None, {"final_state": snapshot}, finished=False)
