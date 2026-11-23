"""A debater reads each earlier argument once. Upstream sends the debate
history and then the latest arguments again, which the history already ends
with. The graph test runs the real compiled graph."""

from __future__ import annotations

from typing import Any

import pytest

from app.services.agents import prompts as prompts_mod
from tests.agents.test_parallel_analysts import (  # noqa: F401 - llm and valuation_delay are fixtures
    REPLY,
    FakeLlm,
    _build,
    _run,
    llm,
    valuation_delay,
)

REPEATED = {
    "bull_researcher": ["current_response"],
    "bear_researcher": ["current_response"],
    "aggressive_debator": ["current_conservative_response", "current_neutral_response"],
    "conservative_debator": ["current_aggressive_response", "current_neutral_response"],
    "neutral_debator": ["current_aggressive_response", "current_conservative_response"],
}


@pytest.mark.parametrize("name", sorted(REPEATED))
def test_a_debater_default_sends_the_history_and_not_its_last_turns_again(name: str) -> None:
    default = prompts_mod.prompt_defaults()[name]

    assert "{history}" in default["text"]
    for field in REPEATED[name]:
        assert f"{{{field}}}" not in default["text"]
        assert field in default["placeholders"]


async def test_each_debater_reads_every_earlier_argument_once(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path, max_debate_rounds=2, max_risk_discuss_rounds=2))

    # Bull, bear, bull, bear, research manager, trader, then six risk turns.
    # Every fake reply is the same text, and a risk debater also reads the
    # trader's proposal.
    assert [prompt.count(REPLY) for prompt in llm.prompts[:4]] == [0, 1, 2, 3]
    assert [prompt.count(REPLY) for prompt in llm.prompts[6:12]] == [1, 2, 3, 4, 5, 6]
