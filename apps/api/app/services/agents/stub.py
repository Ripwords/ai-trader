"""Test hook: ``AGENTS_STUB_RUN_SECONDS=<n>`` replaces the LLM graph with a
stub that sleeps ``n`` seconds inside one node and then decides ``hold``.

Used by ``scripts/repro/`` to exercise idle timeouts, refresh, api restarts,
and resume without API keys or spend. Never set it in production.
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import date
from typing import Any, AsyncIterator

from app.services.agents import graph as graph_mod

logger = logging.getLogger(__name__)

_DECISION = {"rating": "hold", "confidence": 50, "rationale": "stub run"}


def _seconds() -> float:
    return float(os.environ["AGENTS_STUB_RUN_SECONDS"])


class _StubCompiled:
    async def astream(self, *_a: Any, **_kw: Any) -> AsyncIterator[dict]:
        await asyncio.sleep(_seconds())
        yield {"decision": _DECISION}


class _StubGraph:
    graph = _StubCompiled()


def _build_graph(*_a: Any, **_kw: Any) -> _StubGraph:
    return _StubGraph()


async def _run_graph(
    graph: Any, symbol: str, trade_date: date, *_a: Any, **_kw: Any
) -> AsyncIterator[dict]:
    yield {"metadata": {"langgraph_node": "market", "node_finished": False}, "values": {}}
    await asyncio.sleep(_seconds())
    yield {
        "metadata": {"langgraph_node": "trader", "node_finished": True},
        "values": {"decision": _DECISION},
    }


def install_stub_if_enabled() -> bool:
    if not os.environ.get("AGENTS_STUB_RUN_SECONDS"):
        return False
    logger.warning("AGENTS_STUB_RUN_SECONDS is set: agents runs use the sleeping stub graph")
    graph_mod.build_graph = _build_graph
    graph_mod.run_graph = _run_graph
    return True
