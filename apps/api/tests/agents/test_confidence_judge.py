"""Tests for the confidence judge: a separate LLM call that rates how likely
the final decision is to be right, replacing the old free-text regex that
picked up incidental numbers like ``30-day``."""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage

from app.services.agents.confidence import (
    build_judge_prompt,
    judge_confidence,
    parse_judge_reply,
)
from app.services.agents.graph import _translate_states


STATE = {
    "final_trade_decision": "We stay patient. FINAL TRANSACTION PROPOSAL: **HOLD**",
    "trader_investment_plan": "Trader plan text",
    "investment_debate_state": {
        "bull_history": "Bull: margins expanding",
        "bear_history": "Bear: valuation stretched",
        "judge_decision": "Research manager leans hold",
    },
    "risk_debate_state": {
        "aggressive_history": "Aggressive: size up",
        "conservative_history": "Conservative: trim",
        "neutral_history": "Neutral: wait",
    },
}


class FakeLlm:
    def __init__(self, reply: object) -> None:
        self.reply = reply
        self.prompts: list[str] = []
        self.configs: list[object] = []

    async def ainvoke(self, prompt: str, config: object = None) -> AIMessage:
        self.prompts.append(prompt)
        self.configs.append(config)
        if isinstance(self.reply, Exception):
            raise self.reply
        return AIMessage(content=self.reply)


def test_parse_reads_the_confidence_line() -> None:
    assert parse_judge_reply("Weighing both sides.\nCONFIDENCE: 63\nREASON: thin edge") == 63


def test_parse_takes_the_last_confidence_line() -> None:
    assert parse_judge_reply("CONFIDENCE: 40\nOn reflection.\nCONFIDENCE: 57") == 57


def test_parse_accepts_percent_sign_and_markdown() -> None:
    assert parse_judge_reply("**CONFIDENCE:** 71%") == 71


def test_parse_ignores_incidental_numbers() -> None:
    """The old regex read ``low confidence in the 30-day trend`` as 30."""
    assert parse_judge_reply("We have low confidence in the 30-day trend.") is None


def test_parse_rejects_out_of_range() -> None:
    assert parse_judge_reply("CONFIDENCE: 140") is None


def test_parse_rejects_ten_point_scale() -> None:
    assert parse_judge_reply("CONFIDENCE: 8/10") is None


def test_prompt_carries_rating_horizon_and_debate() -> None:
    prompt = build_judge_prompt(STATE, "hold", horizon_days=7)
    assert "HOLD" in prompt
    assert "7 trading days" in prompt
    assert "valuation stretched" in prompt
    assert "Conservative: trim" in prompt
    assert "FINAL TRANSACTION PROPOSAL" in prompt


@pytest.mark.asyncio
async def test_judge_returns_parsed_number_and_forwards_config() -> None:
    llm = FakeLlm("CONFIDENCE: 58\nREASON: split debate")
    config = {"callbacks": ["usage"]}
    assert await judge_confidence(llm, STATE, "hold", config=config) == 58
    assert llm.configs == [config]


@pytest.mark.asyncio
async def test_judge_reads_text_past_thinking_blocks() -> None:
    llm = FakeLlm([
        {"type": "thinking", "thinking": "CONFIDENCE: 99"},
        {"type": "text", "text": "CONFIDENCE: 61"},
    ])
    assert await judge_confidence(llm, STATE, "hold") == 61


@pytest.mark.asyncio
async def test_judge_failure_yields_none() -> None:
    assert await judge_confidence(FakeLlm(RuntimeError("boom")), STATE, "hold") is None


@pytest.mark.asyncio
async def test_judge_unparseable_reply_yields_none() -> None:
    assert await judge_confidence(FakeLlm("I think it's fine."), STATE, "hold") is None


async def _states(*snapshots: dict):
    for s in snapshots:
        yield s


@pytest.mark.asyncio
async def test_translate_states_stamps_judge_confidence_on_decision() -> None:
    seen: list[tuple[dict, str]] = []

    async def judge(state: dict, rating: str) -> int | None:
        seen.append((state, rating))
        return 64

    chunks = [
        c async for c in _translate_states(_states(STATE), None, prev={}, judge=judge)
    ]
    decision = next(c["values"]["decision"] for c in chunks if "decision" in c["values"])
    assert decision["confidence"] == 64
    assert seen == [(STATE, "hold")]


@pytest.mark.asyncio
async def test_translate_states_without_judge_leaves_confidence_unset() -> None:
    text = "Low confidence in the 30-day trend. FINAL TRANSACTION PROPOSAL: **HOLD**"
    chunks = [
        c async for c in _translate_states(
            _states({"final_trade_decision": text}), None, prev={}
        )
    ]
    decision = next(c["values"]["decision"] for c in chunks if "decision" in c["values"])
    assert decision["confidence"] is None
