"""Run user strategy code in a child process with a wall-clock limit.

The AST validator keeps strategy code away from the filesystem and the
interpreter, but it cannot stop ``while True: pass``. A thread cannot be
killed either, so the only way to bound a strategy's runtime is a separate
process that can be. Each call spawns a fresh process (spawn, never fork:
the caller is inside an asyncio loop with open sockets) and kills it on
timeout.
"""

from __future__ import annotations

import multiprocessing as mp
import os
from typing import Any, Callable

DEFAULT_TICK_TIMEOUT_SEC = 10.0
DEFAULT_BACKTEST_TIMEOUT_SEC = 120.0


class StrategyTimeout(Exception):
    pass


def _env_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def tick_timeout_sec() -> float:
    return _env_seconds("ALGO_STRATEGY_TIMEOUT_SEC", DEFAULT_TICK_TIMEOUT_SEC)


def backtest_timeout_sec() -> float:
    return _env_seconds("ALGO_BACKTEST_TIMEOUT_SEC", DEFAULT_BACKTEST_TIMEOUT_SEC)


def _child(conn: Any, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
    try:
        conn.send(("ok", fn(*args, **kwargs)))
    except BaseException as exc:  # noqa: BLE001 — every failure is reported, never swallowed
        conn.send(("err", f"{type(exc).__name__}: {exc}"))
    finally:
        conn.close()


def run_isolated(fn: Callable[..., Any], *args: Any, timeout_sec: float, **kwargs: Any) -> Any:
    """Call ``fn(*args, **kwargs)`` in a child process.

    ``fn`` must be importable by name (a module-level function) and the
    arguments and return value must pickle. Raises :class:`StrategyTimeout`
    after ``timeout_sec`` and re-raises the child's exception as
    ``RuntimeError`` otherwise."""
    ctx = mp.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child, args=(child_conn, fn, args, kwargs), daemon=True)
    proc.start()
    child_conn.close()
    try:
        if not parent_conn.poll(timeout_sec):
            proc.kill()
            raise StrategyTimeout(f"strategy exceeded {timeout_sec:g}s and was killed")
        status, payload = parent_conn.recv()
    finally:
        parent_conn.close()
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join(5)
    if status == "ok":
        return payload
    raise RuntimeError(payload)
