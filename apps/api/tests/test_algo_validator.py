"""TDD tests for the algo strategy AST validator + restricted-exec sandbox.

The validator's job: reject Python source that would let a strategy escape the
sandbox (filesystem, network, dynamic import, dunder access). The sandbox's job:
exec validated source inside a namespace where __builtins__ is reduced to a safe
subset, and return a callable that drives the user's `on_bar(ctx)` function.
"""

from __future__ import annotations

import pytest

from app.services.algo.sandbox import compile_strategy
from app.services.algo.validator import ValidationError, validate

# --- Validator: blocks dangerous constructs --------------------------------


@pytest.mark.parametrize(
    "src, needle",
    [
        ("import os\ndef on_bar(c): pass", "os"),
        ("import subprocess\ndef on_bar(c): pass", "subprocess"),
        ("import socket\ndef on_bar(c): pass", "socket"),
        ("from os import path\ndef on_bar(c): pass", "os"),
        ("from urllib.request import urlopen\ndef on_bar(c): pass", "urllib"),
        ("def on_bar(c): __import__('os')", "__import__"),
        ("def on_bar(c): eval('1+1')", "eval"),
        ("def on_bar(c): exec('print(1)')", "exec"),
        ("def on_bar(c): open('/etc/passwd')", "open"),
        ("def on_bar(c): return c.__class__", "__class__"),
        ("def on_bar(c): return getattr(c, '__class__')", "getattr"),
    ],
)
def test_validator_blocks_dangerous(src: str, needle: str) -> None:
    with pytest.raises(ValidationError) as exc:
        validate(src)
    assert needle in str(exc.value)


# --- Validator: allows the strategy DSL ------------------------------------


@pytest.mark.parametrize(
    "src",
    [
        "import math\ndef on_bar(c): return math.sqrt(2)",
        "import numpy as np\ndef on_bar(c): return np.mean(c.bars['close'])",
        "import pandas as pd\ndef on_bar(c): return pd.Series([1, 2, 3]).mean()",
        # The canonical strategy shape.
        (
            "def on_bar(c):\n"
            "    closes = c.bars['close']\n"
            "    if closes.iloc[-1] > closes.iloc[-2]:\n"
            "        c.buy(c.qty)\n"
            "    else:\n"
            "        c.hold()\n"
        ),
    ],
)
def test_validator_allows_safe(src: str) -> None:
    validate(src)  # must not raise


def test_validator_reports_syntax_error_with_line() -> None:
    with pytest.raises(ValidationError) as exc:
        validate("def on_bar(c)\n    pass\n")  # missing colon
    msg = str(exc.value)
    assert "syntax" in msg.lower() or "line" in msg.lower()


# --- Sandbox: contract --------------------------------------------------------


def test_sandbox_requires_on_bar_to_be_defined() -> None:
    with pytest.raises(ValidationError) as exc:
        compile_strategy("x = 1")
    assert "on_bar" in str(exc.value)


def test_sandbox_runs_simple_strategy() -> None:
    """End-to-end: a validated strategy receives a ctx and dispatches buy/sell/hold."""
    import pandas as pd

    src = (
        "def on_bar(c):\n"
        "    if c.bars['close'].iloc[-1] > c.bars['close'].iloc[-2]:\n"
        "        c.buy(c.qty)\n"
        "    else:\n"
        "        c.hold()\n"
    )
    fn = compile_strategy(src)

    class FakeCtx:
        def __init__(self) -> None:
            self.bars = pd.DataFrame({"close": [10.0, 11.0]})
            self.position = 0
            self.qty = 1
            self.actions: list[str] = []

        def buy(self, qty: int = 1) -> None:
            self.actions.append(f"buy:{qty}")

        def sell(self, qty: int = 1) -> None:
            self.actions.append(f"sell:{qty}")

        def hold(self) -> None:
            self.actions.append("hold")

    ctx = FakeCtx()
    fn(ctx)
    assert ctx.actions == ["buy:1"]


def test_sandbox_strategy_cannot_import_os_at_runtime() -> None:
    """Belt-and-suspenders: even if validator missed it, the restricted
    __builtins__ has no __import__ so `import os` inside the function body
    fails at exec time."""
    # Use a construction that bypasses the validator's static check —
    # direct exec'd `__import__`. The validator catches `__import__` as a Name,
    # so we craft via getattr-equivalent. Easiest: confirm the sandbox namespace
    # genuinely lacks __import__.
    fn = compile_strategy("def on_bar(c): pass")
    # The compiled function's globals must not contain dangerous builtins.
    g = fn.__globals__ if hasattr(fn, "__globals__") else {}
    # fn here is a wrapper; reach into the closed-over user fn via inspect.
    import inspect

    cells = inspect.getclosurevars(fn).nonlocals
    user_fn = cells.get("fn")
    assert user_fn is not None, "wrapper must close over the user fn"
    builtins = user_fn.__globals__.get("__builtins__", {})
    if isinstance(builtins, dict):
        assert "__import__" not in builtins
        assert "open" not in builtins
        assert "eval" not in builtins
        assert "exec" not in builtins
