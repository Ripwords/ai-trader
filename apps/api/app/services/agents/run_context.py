"""What one run adds to every debate prompt.

Upstream's debate nodes build their prompt from a fixed set of state fields
and call ``llm.invoke`` once. Wrapping the model a node is handed reaches all
of them without forking a node, and it works whatever text Settings has saved
for that node: an override needs no placeholder to receive the run's context.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class RunContext:
    """Filled in before the debate opens, read each time a debate node prompts."""

    valuation: str = ""

    def render(self) -> str:
        return "\n\n".join(section for section in (self.valuation,) if section)


class ContextLlm:
    """A debate node's model, with the run's context appended to its prompt."""

    def __init__(self, llm: Any, context: RunContext) -> None:
        self._llm = llm
        self._context = context

    def invoke(self, prompt: Any, *args: Any, **kwargs: Any) -> Any:
        return self._llm.invoke(_append(prompt, self._context.render()), *args, **kwargs)


def _append(prompt: Any, text: str) -> Any:
    """``prompt`` with ``text`` after it. Upstream sends a string from every
    debate node except the Trader, which sends role dicts ending in the request."""
    if not text:
        return prompt
    if isinstance(prompt, str):
        return f"{prompt}\n\n{text}"
    if isinstance(prompt, list) and prompt and isinstance(prompt[-1], dict):
        last = prompt[-1]
        return [*prompt[:-1], {**last, "content": f"{last['content']}\n\n{text}"}]
    raise TypeError(f"cannot add run context to a {type(prompt).__name__} prompt")
