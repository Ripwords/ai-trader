"""Tests for the LangChain UsageAccumulator callback.

The accumulator hooks into LangChain's ``on_llm_end`` and sums prompt/completion
token counts across an entire LangGraph run. We exercise the two normalised
shapes LangChain emits in practice:

* OpenAI-style: ``llm_output['token_usage']`` with ``prompt_tokens`` /
  ``completion_tokens``.
* Anthropic-style: ``generation.message.usage_metadata`` with ``input_tokens``
  / ``output_tokens``.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from app.services.agents.usage import UsageAccumulator


@pytest.mark.asyncio
async def test_accumulates_openai_style_token_usage() -> None:
    acc = UsageAccumulator()
    result = LLMResult(
        generations=[[]],
        llm_output={
            "token_usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
            }
        },
    )
    await acc.on_llm_end(result)
    assert acc.tokens_in == 100
    assert acc.tokens_out == 50


@pytest.mark.asyncio
async def test_accumulates_alt_openai_input_output_keys() -> None:
    """Some langchain-openai versions surface ``input_tokens`` / ``output_tokens``."""
    acc = UsageAccumulator()
    result = LLMResult(
        generations=[[]],
        llm_output={
            "usage": {
                "input_tokens": 7,
                "output_tokens": 11,
            }
        },
    )
    await acc.on_llm_end(result)
    assert acc.tokens_in == 7
    assert acc.tokens_out == 11


@pytest.mark.asyncio
async def test_accumulates_anthropic_style_usage_metadata() -> None:
    acc = UsageAccumulator()
    msg = AIMessage(
        content="hi",
        usage_metadata={
            "input_tokens": 12,
            "output_tokens": 34,
            "total_tokens": 46,
        },
    )
    gen = ChatGeneration(message=msg)
    result = LLMResult(generations=[[gen]], llm_output=None)
    await acc.on_llm_end(result)
    assert acc.tokens_in == 12
    assert acc.tokens_out == 34


@pytest.mark.asyncio
async def test_sums_across_multiple_calls() -> None:
    acc = UsageAccumulator()
    a = LLMResult(
        generations=[[]],
        llm_output={"token_usage": {"prompt_tokens": 10, "completion_tokens": 5}},
    )
    b = LLMResult(
        generations=[[]],
        llm_output={"token_usage": {"prompt_tokens": 3, "completion_tokens": 4}},
    )
    await acc.on_llm_end(a)
    await acc.on_llm_end(b)
    assert acc.tokens_in == 13
    assert acc.tokens_out == 9


@pytest.mark.asyncio
async def test_no_usage_payload_is_no_op() -> None:
    acc = UsageAccumulator()
    result = LLMResult(generations=[[]], llm_output={})
    await acc.on_llm_end(result)
    assert acc.tokens_in == 0
    assert acc.tokens_out == 0


@pytest.mark.asyncio
async def test_handles_string_token_counts() -> None:
    """Some providers stringify tokens; coerce defensively."""
    acc = UsageAccumulator()
    result = LLMResult(
        generations=[[]],
        llm_output={"token_usage": {"prompt_tokens": "8", "completion_tokens": "2"}},
    )
    await acc.on_llm_end(result)
    assert acc.tokens_in == 8
    assert acc.tokens_out == 2


@pytest.mark.asyncio
async def test_no_message_attr_is_skipped() -> None:
    """A bare ``Generation`` (no ``.message``) shouldn't crash the scan."""
    from langchain_core.outputs import Generation

    acc = UsageAccumulator()
    gen = Generation(text="hi")
    result = LLMResult(generations=[[gen]], llm_output={})
    await acc.on_llm_end(result)
    assert acc.tokens_in == 0
    assert acc.tokens_out == 0
