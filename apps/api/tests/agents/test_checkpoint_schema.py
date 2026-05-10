"""Tests for the LangGraph checkpoint pool's schema isolation.

The :class:`AsyncPostgresSaver` doesn't expose a ``schema`` kwarg, so we
isolate its tables (``checkpoints``, ``checkpoint_blobs``,
``checkpoint_writes``) from the rest of the public schema by:

1. Creating a ``langgraph`` schema during lifespan startup.
2. Wiring an :class:`AsyncConnectionPool` ``configure`` callback that runs
   ``SET search_path TO langgraph, public`` on every connection it hands out.

This test asserts the configure callback issues that statement; an
end-to-end "tables landed in langgraph" check would require a live
Postgres which we keep out of unit tests (the testcontainer fixture is
session-scoped and shared with the agent tests).
"""

from __future__ import annotations

from typing import Any

import pytest

from app.main import _configure_checkpointer_connection


class FakeConn:
    """Minimal stand-in for psycopg.AsyncConnection used to record execute() calls."""

    def __init__(self) -> None:
        self.executed: list[str] = []

    async def execute(self, query: str, *args: Any) -> None:
        self.executed.append(query)


@pytest.mark.asyncio
async def test_configure_callback_sets_search_path() -> None:
    conn = FakeConn()
    await _configure_checkpointer_connection(conn)
    assert any("search_path" in q.lower() for q in conn.executed), conn.executed
    assert any("langgraph" in q.lower() for q in conn.executed), conn.executed
