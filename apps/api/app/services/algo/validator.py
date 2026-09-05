"""AST-walk allowlist for user-authored strategy code.

Rejects anything that could escape the sandbox: filesystem, network,
dynamic import, dunder access, or known-dangerous builtins. Allows the
small set of math/data-analysis modules a strategy needs.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

# Top-level module names the strategy is allowed to import.
ALLOWED_MODULES: frozenset[str] = frozenset(
    {"math", "numpy", "pandas", "statistics"}
)

# Builtins a strategy must not reference. Anything that lets it reach into
# the interpreter (eval/exec/compile/__import__), the filesystem (open),
# or the call stack/globals (vars/globals/locals/getattr-by-name).
BANNED_NAMES: frozenset[str] = frozenset(
    {
        "__import__",
        "eval",
        "exec",
        "compile",
        "open",
        "input",
        "breakpoint",
        "globals",
        "locals",
        "vars",
        "getattr",
        "setattr",
        "delattr",
        "exit",
        "quit",
        "help",
    }
)

# Dunder attributes that are allowed (everything else starting and ending
# with __ is rejected — that closes the `obj.__class__.__bases__` escape).
_ALLOWED_DUNDERS: frozenset[str] = frozenset({"__name__", "__doc__"})

# pandas / numpy are handed to the strategy as whole modules, and their IO
# surface reaches the filesystem (``pd.read_csv('/etc/passwd')``) and the
# pickle loader (``pd.read_pickle`` = arbitrary code). Instance methods carry
# the same risk (``c.bars.to_csv('/tmp/x')``), so the ban is on the attribute
# name wherever it appears.
BANNED_ATTRS: frozenset[str] = frozenset(
    {
        # pandas readers / writers
        "read_csv", "read_table", "read_fwf", "read_pickle", "read_excel",
        "read_parquet", "read_feather", "read_hdf", "read_sql", "read_sql_query",
        "read_sql_table", "read_json", "read_html", "read_xml", "read_stata",
        "read_sas", "read_spss", "read_orc", "read_clipboard", "read_gbq",
        "to_csv", "to_pickle", "to_excel", "to_parquet", "to_feather", "to_hdf",
        "to_sql", "to_json", "to_html", "to_xml", "to_stata", "to_orc",
        "to_clipboard", "to_gbq", "to_latex", "to_markdown",
        # numpy file IO
        "load", "save", "savez", "savez_compressed", "loadtxt", "savetxt",
        "genfromtxt", "fromfile", "tofile", "memmap", "fromregex",
        # module internals that reach the interpreter
        "io", "compat", "ctypeslib", "testing", "util",
    }
)


@dataclass
class ValidationError(Exception):
    message: str
    line: int | None = None

    def __str__(self) -> str:
        if self.line is not None:
            return f"line {self.line}: {self.message}"
        return self.message


class _Visitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.errors: list[ValidationError] = []

    def _err(self, node: ast.AST, msg: str) -> None:
        self.errors.append(ValidationError(msg, getattr(node, "lineno", None)))

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            root = alias.name.split(".", 1)[0]
            if root not in ALLOWED_MODULES:
                self._err(node, f"import of '{alias.name}' is not allowed")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        root = (node.module or "").split(".", 1)[0]
        if root and root not in ALLOWED_MODULES:
            self._err(node, f"import from '{node.module}' is not allowed")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in BANNED_NAMES:
            self._err(node, f"'{node.id}' is not allowed")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        attr = node.attr
        if (
            attr.startswith("__")
            and attr.endswith("__")
            and attr not in _ALLOWED_DUNDERS
        ):
            self._err(node, f"dunder attribute '{attr}' is not allowed")
        elif attr in BANNED_ATTRS:
            self._err(node, f"attribute '{attr}' is not allowed (file/network IO)")
        self.generic_visit(node)


def validate(src: str) -> None:
    """Raise ValidationError if `src` contains disallowed constructs OR
    fails to define a top-level `on_bar(c)` function."""
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        raise ValidationError(f"syntax error: {e.msg}", e.lineno) from e

    v = _Visitor()
    v.visit(tree)
    if v.errors:
        joined = "; ".join(str(e) for e in v.errors)
        raise ValidationError(joined, v.errors[0].line)

    # The runtime imports the strategy and calls `on_bar(ctx)` once per
    # bar. The LLM occasionally produces bare module-level code that
    # references `c.bars` directly; that fails at exec time with the
    # cryptic `name 'c' is not defined`. Catch it here with a clearer
    # message so the chat can prompt the model to fix it.
    has_on_bar = any(
        isinstance(node, ast.FunctionDef)
        and node.name == "on_bar"
        and len(node.args.args) >= 1
        for node in tree.body
    )
    if not has_on_bar:
        raise ValidationError(
            "strategy must define a top-level `def on_bar(c):` function — "
            "the runtime calls it once per bar with the bar context"
        )
