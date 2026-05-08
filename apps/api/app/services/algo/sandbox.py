"""Restricted-exec sandbox for strategy code.

Compiles validated source into a callable `on_bar(ctx)` whose globals
expose only a tight whitelist of builtins and data-science modules.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Protocol

import numpy as np
import pandas as pd

from .validator import ValidationError, validate

# Safe subset of Python builtins. Keep this list short; expand only when a
# concrete strategy needs something and it has no escape value.
_SAFE_BUILTINS: dict[str, Any] = {
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "range": range,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "True": True,
    "False": False,
    "None": None,
    "isinstance": isinstance,
    "print": print,  # noisy at scale, but harmless
}


class StrategyCtx(Protocol):
    """The runtime contract that strategy authors code against."""

    bars: pd.DataFrame
    position: int
    qty: int

    def buy(self, qty: int = ...) -> None: ...
    def sell(self, qty: int = ...) -> None: ...
    def hold(self) -> None: ...


def compile_strategy(src: str) -> Callable[[StrategyCtx], None]:
    """Validate `src` and return its `on_bar` function bound to a restricted
    globals dict. Raises ValidationError on rejected source or missing on_bar.
    """
    validate(src)

    namespace: dict[str, Any] = {
        "__builtins__": _SAFE_BUILTINS,
        "np": np,
        "numpy": np,
        "pd": pd,
        "pandas": pd,
        "math": math,
    }
    exec(compile(src, "<strategy>", "exec"), namespace)  # noqa: S102 — sandboxed

    fn = namespace.get("on_bar")
    if not callable(fn):
        raise ValidationError("strategy must define on_bar(ctx)")

    def call(ctx: StrategyCtx) -> None:
        fn(ctx)

    return call
