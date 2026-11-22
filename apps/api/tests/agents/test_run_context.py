from __future__ import annotations

from typing import Any

import pytest

from app.services.agents.run_context import ContextLlm, RunContext


class _Recorder:
    def __init__(self) -> None:
        self.seen: list[Any] = []

    def invoke(self, prompt: Any) -> str:
        self.seen.append(prompt)
        return "reply"


def test_an_empty_context_leaves_the_prompt_alone() -> None:
    llm = _Recorder()

    assert ContextLlm(llm, RunContext()).invoke("judge this") == "reply"
    assert llm.seen == ["judge this"]


def test_the_context_is_read_when_the_node_prompts_not_when_it_is_built() -> None:
    llm, context = _Recorder(), RunContext()
    wrapped = ContextLlm(llm, context)

    context.valuation = "## Valuation\nfair value 10"
    wrapped.invoke("judge this")

    assert llm.seen == ["judge this\n\n## Valuation\nfair value 10"]


def test_the_trader_request_gets_the_context_and_its_messages_are_not_mutated() -> None:
    llm = _Recorder()
    messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "plan"}]

    ContextLlm(llm, RunContext(valuation="V")).invoke(messages)

    assert llm.seen == [[{"role": "system", "content": "sys"}, {"role": "user", "content": "plan\n\nV"}]]
    assert messages[-1]["content"] == "plan"


def test_an_unknown_prompt_shape_fails_loudly() -> None:
    with pytest.raises(TypeError, match="cannot add run context"):
        ContextLlm(_Recorder(), RunContext(valuation="V")).invoke(42)
