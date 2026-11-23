"""No debater is told it has lessons from past decisions: nothing here ever
stores any. The graph tests run the real compiled graph."""

from __future__ import annotations

from typing import Any

import pytest
from tradingagents.agents import prompts as ta_prompts

from app.services.agents import prompts as prompts_mod
from tests.agents.test_parallel_analysts import (  # noqa: F401 - llm and valuation_delay are fixtures
    FakeLlm,
    _build,
    _run,
    llm,
    valuation_delay,
)

REMEMBERING = ("bull_researcher", "bear_researcher", "research_manager", "trader_system", "risk_manager")

# Words upstream uses to ask for a memory the node does not have.
MEMORY_WORDS = (
    "past_memory_str",
    "reflection",
    "lessons",
    "past mistakes",
    "mistakes you made",
    "learn from",
    "learning and improving",
    "continuous improvement",
    "no past memories found",
)


def _upstream(name: str) -> str:
    return (ta_prompts._PROMPT_DIR / f"{name}.md").read_text()


@pytest.mark.parametrize("name", sorted(prompts_mod.NODE_PROMPTS))
def test_no_default_prompt_asks_for_past_lessons(name: str) -> None:
    text = prompts_mod.raw_node_prompt(name).lower()

    assert [word for word in MEMORY_WORDS if word in text] == []


@pytest.mark.parametrize("name", REMEMBERING)
def test_the_roles_upstream_gave_a_memory_are_told_they_have_none(name: str) -> None:
    text = prompts_mod.raw_node_prompt(name)

    assert text.count(prompts_mod.NO_MEMORY) == 1
    assert "past_memory_str" in _upstream(name)


@pytest.mark.parametrize("name", REMEMBERING)
def test_a_saved_override_may_still_use_the_memory_placeholder(name: str) -> None:
    default = prompts_mod.prompt_defaults()[name]

    assert "past_memory_str" in default["placeholders"]
    assert "{past_memory_str}" not in default["text"]


def test_an_edit_whose_target_left_upstream_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(
        prompts_mod.DEFAULT_PROMPT_EDITS, "trader_user", (("text upstream never had", ""),)
    )

    with pytest.raises(ValueError, match="trader_user"):
        prompts_mod.raw_node_prompt("trader_user")


async def test_no_debate_prompt_of_a_run_mentions_a_memory(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path))

    assert len(llm.prompts) == 8
    for prompt in llm.prompts:
        assert [word for word in MEMORY_WORDS if word in prompt.lower()] == []
    assert len([p for p in llm.prompts if prompts_mod.NO_MEMORY in p]) == 5


async def test_a_saved_override_that_asks_for_memories_is_told_there_are_none(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    token = prompts_mod.set_run_overrides({
        "trader_system": "MYTRADER memories=[{past_memory_str}] FINAL TRANSACTION PROPOSAL",
        "bull_researcher": "MYBULL memories=[{past_memory_str}] {history}",
    })
    try:
        prompts_mod.install_prompt_overrides()
        await _run(_build(tmp_path))
    finally:
        prompts_mod.reset_run_overrides(token)

    for marker in ("MYTRADER", "MYBULL"):
        [prompt] = [p for p in llm.prompts if marker in p]
        assert f"memories=[{prompts_mod.NO_MEMORY_VALUE}" in prompt
