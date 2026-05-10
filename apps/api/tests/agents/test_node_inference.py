"""Tests for early node-name attribution in run_graph.

Without these, a chunk emitted while an analyst is mid-run (calling tools but
hasn't finalised its report yet) gets ``node=None``, the streaming translator
never emits ``node-start``, and the UI sits on "running…" with no progress for
the 15-30s it takes the first analyst to write its report. By inferring the
node from the tool name in flight, the first ``node-start`` fires within ~1s
of the first tool call.
"""

from __future__ import annotations

from app.services.agents.graph import _infer_node_from_tools


def test_infer_node_from_balance_sheet_call() -> None:
    node = _infer_node_from_tools(
        calls=[{"name": "get_balance_sheet", "args": {"ticker": "NVDA"}}],
        results=[],
    )
    assert node == "Fundamentals Analyst"


def test_infer_node_from_market_data_tool_result() -> None:
    """Tool results alone (e.g. an analyst that calls tools then waits for the
    LLM next iteration) should still attribute the node so the UI keeps the
    card visible across iterations."""
    node = _infer_node_from_tools(
        calls=[],
        results=[{"name": "get_indicators", "ok": True, "preview": "..."}],
    )
    assert node == "Market Analyst"


def test_infer_node_returns_none_for_unknown_tool() -> None:
    """An unknown tool means we can't pin attribution — caller leaves node as
    None so the chunk falls back to whatever ``_detect_node`` produced (which
    may itself be None, and that's fine)."""
    node = _infer_node_from_tools(
        calls=[{"name": "some_internal_helper", "args": {}}],
        results=[],
    )
    assert node is None


def test_infer_node_returns_none_for_empty_lists() -> None:
    assert _infer_node_from_tools(calls=[], results=[]) is None


def test_infer_node_news_tools_route_to_news_analyst() -> None:
    """Both per-symbol and global news tools attribute to the News Analyst."""
    assert (
        _infer_node_from_tools(
            calls=[{"name": "get_news", "args": {"ticker": "AAPL"}}], results=[]
        )
        == "News Analyst"
    )
    assert (
        _infer_node_from_tools(
            calls=[{"name": "get_global_news", "args": {}}], results=[]
        )
        == "News Analyst"
    )
