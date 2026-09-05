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
        # pandas/numpy are injected as whole modules; their IO surface reaches
        # the filesystem and, via pickle, arbitrary code.
        ("def on_bar(c): pd.read_pickle('/tmp/evil.pkl')", "read_pickle"),
        ("def on_bar(c): pd.read_csv('/etc/passwd')", "read_csv"),
        ("def on_bar(c): c.bars.to_csv('/tmp/out.csv')", "to_csv"),
        ("import pandas as x\ndef on_bar(c): x.io.parsers.read_csv('/etc/passwd')", "io"),
        ("def on_bar(c): np.load('/tmp/evil.npy', allow_pickle=True)", "load"),
        ("def on_bar(c): np.savetxt('/tmp/out.txt', [1])", "savetxt"),
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


def test_validator_rejects_missing_on_bar_with_clear_message() -> None:
    """LLMs occasionally emit bare module-level code (referencing `c.bars`
    without wrapping in `def on_bar(c):`). At exec time that surfaces as
    `name 'c' is not defined`; the validator should catch it earlier with
    actionable guidance."""
    bare = (
        "df = c.bars\n"
        "if len(df) < 20:\n"
        "    c.hold()\n"
    )
    with pytest.raises(ValidationError) as exc:
        validate(bare)
    msg = str(exc.value)
    assert "on_bar" in msg


def test_validator_rejects_on_bar_with_no_parameter() -> None:
    """`def on_bar():` (no params) is syntactically a function but doesn't
    match the runtime contract — the runtime always calls it with ctx."""
    with pytest.raises(ValidationError) as exc:
        validate("def on_bar():\n    pass\n")
    assert "on_bar" in str(exc.value)


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


def test_sandbox_runs_strategy_with_import_math() -> None:
    """Regression: validator allowed `import math` so the wire-format strategy
    contained one, but the sandbox's restricted __builtins__ lacked
    __import__ — so executing the import statement raised
    `NameError: __import__ not found` at backtest time. Sandbox now exposes
    a restricted __import__ that mirrors the validator's allowlist."""
    src = (
        "import math\n"
        "def on_bar(c):\n"
        "    c.last = math.sqrt(4)\n"
    )
    fn = compile_strategy(src)

    class FakeCtx:
        last: float = 0.0

        def buy(self, qty: int = 1) -> None: ...
        def sell(self, qty: int = 1) -> None: ...
        def hold(self) -> None: ...

    ctx = FakeCtx()
    fn(ctx)
    assert ctx.last == 2.0


def test_sandbox_import_rejects_disallowed_modules_at_runtime() -> None:
    """Belt-and-suspenders: the restricted __import__ refuses anything
    outside the validator's allowlist, so even if a strategy reached
    runtime with an `import os`, the import call would raise."""
    import inspect

    fn = compile_strategy("def on_bar(c): pass")
    cells = inspect.getclosurevars(fn).nonlocals
    user_fn = cells.get("fn")
    assert user_fn is not None, "wrapper must close over the user fn"
    builtins = user_fn.__globals__.get("__builtins__", {})
    assert isinstance(builtins, dict)
    # __import__ is exposed (necessary for `import math` to work), but
    # restricted; eval/exec/open/etc. remain absent entirely.
    assert "__import__" in builtins
    assert "open" not in builtins
    assert "eval" not in builtins
    assert "exec" not in builtins
    safe_import = builtins["__import__"]
    with pytest.raises(ImportError):
        safe_import("os")
    with pytest.raises(ImportError):
        safe_import("subprocess")
    # Allowed modules still resolve.
    assert safe_import("math").sqrt(4) == 2.0
