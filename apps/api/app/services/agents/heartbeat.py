"""Interleave keepalive markers into a slow async iterator.

An LLM node can think for minutes without producing an event. Anything
between here and the browser (undici's body timeout, nginx's read timeout)
treats that silence as a dead connection, so the router emits a heartbeat
line whenever the source has been quiet for ``interval`` seconds.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, Final, TypeVar

T = TypeVar("T")


class _Heartbeat:
    def __repr__(self) -> str:
        return "HEARTBEAT"


HEARTBEAT: Final = _Heartbeat()
_DONE: Final = object()


async def with_heartbeats(
    source: AsyncIterator[T], interval: float
) -> AsyncIterator[T | _Heartbeat]:
    # The source runs in one dedicated task rather than one task per
    # ``anext``: LangGraph and LangChain keep callback state in contextvars,
    # which a fresh task per step would silently reset.
    queue: asyncio.Queue[object] = asyncio.Queue()

    async def pump() -> None:
        try:
            async for item in source:
                await queue.put(item)
        except BaseException as e:  # noqa: BLE001 - re-raised in the consumer
            await queue.put(e)
            return
        await queue.put(_DONE)

    producer = asyncio.create_task(pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
            except TimeoutError:
                yield HEARTBEAT
                continue
            if item is _DONE:
                return
            if isinstance(item, BaseException):
                raise item
            yield item  # type: ignore[misc]
    finally:
        if not producer.done():
            producer.cancel()
            try:
                await producer
            except BaseException:  # noqa: BLE001
                pass
