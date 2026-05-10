"""LangGraph -> NDJSON event translator.

Input contract: an async iterator of **normalized** chunks shaped like::

    {
        "metadata": {"langgraph_node": str | None, "node_finished": bool},
        "values":   {                       # any subset of these keys
            "tool_calls":   list[{"name", "args"}],
            "tool_results": list[{"name", "ok", "preview"}],
            "debate":       {"round", "side", "text"},
            "decision":     {"rating", "confidence", "rationale"},
            "messages":     list[{"role", "content"}],
        }
    }

This is **not** the raw shape ``TradingAgentsGraph.graph.astream`` emits — that
stream yields full ``AgentState`` snapshots in ``stream_mode="values"`` mode
without any ``langgraph_node``/``node_finished`` metadata. The adapter that
diffs successive AgentState snapshots and produces the dict shape above lives
in :mod:`app.services.agents.graph` (``run_graph``). Keeping that adapter out
of this module lets the translator stay provider-agnostic and unit-testable
with hand-authored fixtures.

Output: an async iterator of NDJSON-ready dicts in the run-event taxonomy
(``run-start``, ``node-start``, ``tool-call``, ``tool-result``, ``debate-round``,
``decision``, ``node-end``). The caller appends ``run-end`` (and ``error``)
because they need the totals/exception that translation can't see.
"""

from __future__ import annotations

from typing import AsyncIterator


async def translate_chunks(
    chunks: AsyncIterator[dict],
    run_id: str,
    symbol: str,
    config: dict,
) -> AsyncIterator[dict]:
    """Translate normalized stream chunks into wire-shaped run events.

    Emits ``run-start`` first; the caller appends ``run-end`` after the
    stream ends so it can carry per-run totals (tokens, cost).
    """
    yield {
        "type": "run-start",
        "run_id": run_id,
        "symbol": symbol,
        "config": config,
    }
    seen_nodes: set[str] = set()
    async for chunk in chunks:
        meta = chunk.get("metadata") or {}
        node = meta.get("langgraph_node")
        values = chunk.get("values") or {}

        if node and node not in seen_nodes:
            seen_nodes.add(node)
            yield {"type": "node-start", "node": node}

        for tc in values.get("tool_calls") or []:
            yield {
                "type": "tool-call",
                "node": node,
                "tool": tc.get("name"),
                "args": tc.get("args") or {},
            }
        for tr in values.get("tool_results") or []:
            preview = (tr.get("preview") or "")[:500]
            yield {
                "type": "tool-result",
                "node": node,
                "tool": tr.get("name"),
                "ok": bool(tr.get("ok", True)),
                "preview": preview,
            }
        debate = values.get("debate")
        if debate:
            yield {
                "type": "debate-round",
                "round": debate.get("round"),
                "side": debate.get("side"),
                "text": debate.get("text", ""),
            }
        risk_debate = values.get("risk_debate")
        if risk_debate:
            yield {
                "type": "risk-debate-turn",
                "speaker": risk_debate.get("speaker"),
                "text": risk_debate.get("text", ""),
                "turn": risk_debate.get("turn", 0),
            }
        # Full per-analyst markdown reports — one event each so the UI can
        # attach them to the right step card. ``content`` is the unmodified
        # report; truncation is the renderer's choice.
        for r in values.get("reports") or []:
            yield {
                "type": "report",
                "kind": r.get("kind"),
                "node": r.get("node"),
                "content": r.get("content", ""),
            }
        # Synthesis artifacts — Research Manager's investment_plan, Trader's
        # trader_investment_plan, intermediate judge_decisions.
        for s in values.get("synthesis") or []:
            yield {
                "type": "synthesis",
                "stage": s.get("stage"),
                "node": s.get("node"),
                "content": s.get("content", ""),
            }
        decision = values.get("decision")
        if decision:
            yield {
                "type": "decision",
                "rating": decision.get("rating"),
                "confidence": decision.get("confidence"),
                "rationale": decision.get("rationale", ""),
            }
        final_state = values.get("final_state")
        if final_state:
            # Forwarded to the proxy tee which persists it on
            # ``agent_runs.final_state``. Per-role reflection reads it later
            # to drive Reflector lessons without re-walking agent_messages.
            yield {"type": "final-state", "state": final_state}
        if meta.get("node_finished") and node:
            messages = values.get("messages") or []
            summary = ""
            for m in reversed(messages):
                if m.get("role") == "assistant":
                    summary = (m.get("content") or "")[:500]
                    break
            yield {"type": "node-end", "node": node, "summary": summary}
