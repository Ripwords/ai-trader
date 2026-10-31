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
        # file/url handles constructed as objects
        "HDFStore", "ExcelWriter", "ExcelFile", "DataSource", "open",
        # module internals that reach the interpreter
        "io", "compat", "ctypeslib", "testing", "util",
        "core", "lib", "f2py", "api", "plotting", "tseries",
        # stdlib modules an allowed package re-exports (``statistics.sys``) or
        # imports internally (``pandas.io.common.os``)
        "os", "sys", "subprocess", "builtins", "importlib", "shutil", "socket",
        "pathlib", "pickle", "marshal", "ctypes", "inspect", "gc", "signal",
        "threading", "multiprocessing", "urllib", "http", "glob", "tempfile",
        "platform", "runpy", "pty", "posix", "mmap", "codecs", "zipfile",
        "tarfile", "sysconfig", "types", "weakref",
    }
)


def name_problem(name: str) -> str | None:
    """Why a module path segment, imported name or attribute is refused, or None.

    The same rule covers ``x.attr``, ``import a.b`` and ``from a import b``:
    each is a way to reach a name inside an allowed package.
    """
    if name.startswith("__") and name.endswith("__"):
        if name in _ALLOWED_DUNDERS:
            return None
        return f"dunder attribute '{name}' is not allowed"
    if name.startswith("_"):
        return f"private name '{name}' is not allowed"
    if name in BANNED_ATTRS:
        return f"'{name}' is not allowed (file/network IO or interpreter access)"
    return None


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
                continue
            for part in alias.name.split(".")[1:]:
                if problem := name_problem(part):
                    self._err(node, f"import of '{alias.name}': {problem}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level:
            self._err(node, "relative imports are not allowed")
            return
        parts = (node.module or "").split(".")
        if parts[0] not in ALLOWED_MODULES:
            self._err(node, f"import from '{node.module}' is not allowed")
            return
        for part in parts[1:]:
            if problem := name_problem(part):
                self._err(node, f"import from '{node.module}': {problem}")
        for alias in node.names:
            if alias.name == "*":
                self._err(node, f"'from {node.module} import *' is not allowed")
            elif problem := name_problem(alias.name):
                self._err(node, f"importing '{alias.name}': {problem}")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id in BANNED_NAMES:
            self._err(node, f"'{node.id}' is not allowed")

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if problem := name_problem(node.attr):
            self._err(node, problem)
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
        # Each error carries its own "line N:" prefix already.
        joined = "; ".join(str(e) for e in v.errors)
        raise ValidationError(joined)

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
