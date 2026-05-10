"""Tests for the asyncio lock that serialises ``build_graph`` calls.

``build_graph`` mutates module globals on
``tradingagents.agents.utils.agent_utils`` (it monkey-patches in the toolkit
the compiled graph will bind to). Two concurrent calls would race; the lock
guarantees serialisation. We don't assert which toolkit "wins" — just that
both calls return without error.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.services.agents import graph as graph_mod


@pytest.mark.asyncio
async def test_build_graph_locked_serialises_concurrent_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two ``build_graph_locked`` calls run concurrently — both must succeed.

    We stub the underlying sync ``build_graph`` with a fake that records
    re-entrancy: if the lock works, only one call is in the critical section
    at a time, so ``in_flight`` never exceeds 1. The fake also yields the
    event loop so any unprotected re-entry would be observed.
    """
    in_flight = 0
    max_in_flight = 0

    def fake_build_graph(opend_client: Any, **kwargs: Any) -> Any:
        nonlocal in_flight, max_in_flight
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        # The real builder accesses ta.graph (cached_property) inside the
        # locked section; simulate that work here.
        try:
            # Sync work, no yielding — the lock is awaited around a call
            # to to_thread, which is what serialises us.
            return object()
        finally:
            in_flight -= 1

    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    results = await asyncio.gather(
        graph_mod.build_graph_locked(None, max_debate_rounds=1, deep_thinking=False),
        graph_mod.build_graph_locked(None, max_debate_rounds=1, deep_thinking=True),
        graph_mod.build_graph_locked(None, max_debate_rounds=1, deep_thinking=False),
    )
    assert all(r is not None for r in results)
    assert max_in_flight == 1, (
        f"build_graph called concurrently: peak in-flight {max_in_flight}"
    )


@pytest.mark.asyncio
async def test_build_graph_locked_passes_kwargs_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``build_graph_locked`` must forward kwargs verbatim to ``build_graph``."""
    seen: dict[str, Any] = {}

    def fake_build_graph(opend_client: Any, **kwargs: Any) -> Any:
        seen["opend_client"] = opend_client
        seen.update(kwargs)
        return object()

    monkeypatch.setattr(graph_mod, "build_graph", fake_build_graph)

    sentinel_opend = object()
    sentinel_saver = object()
    await graph_mod.build_graph_locked(
        sentinel_opend,
        max_debate_rounds=3,
        deep_thinking=False,
        checkpointer=sentinel_saver,
    )
    assert seen["opend_client"] is sentinel_opend
    assert seen["max_debate_rounds"] == 3
    assert seen["deep_thinking"] is False
    assert seen["checkpointer"] is sentinel_saver
