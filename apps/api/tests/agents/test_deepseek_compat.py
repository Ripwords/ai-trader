"""DeepSeek v4 thinking-mode compatibility for the LiteLLM-routed agents path.

LangChain returns an ``AIMessage`` whose ``content`` is a block list containing
``{"type": "thinking", ...}``. ``langchain_litellm._convert_message_to_dict``
drops ``tool_use``/``tool_call`` blocks but passes every other unrecognised dict
through unchanged, so the thinking block is serialised back into the next
request and DeepSeek rejects the whole call:

    Failed to deserialize the JSON body into the target type: messages[1]:
    unknown variant `thinking`, expected one of `text`, `image_url`, `file`

That kills the second turn of LangGraph's tool loop — assistant -> tool_call ->
tool_result -> assistant — which is every multi-analyst run.
"""
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.services.agents.deepseek_compat import (
    install_litellm_thinking_patch,
    strip_reasoning_blocks,
)


def test_strips_thinking_block_and_keeps_text():
    content = [
        {"type": "thinking", "thinking": "internal deliberation"},
        {"type": "text", "text": "The price is $123.45."},
    ]
    assert strip_reasoning_blocks(content) == [{"type": "text", "text": "The price is $123.45."}]


def test_collapses_to_empty_string_when_only_reasoning():
    # A tool-calling turn often carries reasoning and no text at all.
    assert strip_reasoning_blocks([{"type": "thinking", "thinking": "call the tool"}]) == ""


def test_drops_every_known_reasoning_variant():
    content = [
        {"type": "thinking", "thinking": "a"},
        {"type": "reasoning", "reasoning": "b"},
        {"type": "reasoning_content", "reasoning_content": "c"},
        {"type": "redacted_thinking", "data": "d"},
        {"type": "text", "text": "keep"},
    ]
    assert strip_reasoning_blocks(content) == [{"type": "text", "text": "keep"}]


def test_leaves_plain_strings_and_other_blocks_alone():
    assert strip_reasoning_blocks("just a string") == "just a string"
    image = [{"type": "image_url", "image_url": {"url": "http://x/y.png"}}]
    assert strip_reasoning_blocks(image) == image


def test_patch_makes_converter_drop_thinking_blocks():
    install_litellm_thinking_patch()
    from langchain_litellm.chat_models.litellm import _convert_message_to_dict

    msg = AIMessage(content=[
        {"type": "thinking", "thinking": "deliberating"},
        {"type": "text", "text": "done"},
    ])
    assert _convert_message_to_dict(msg)["content"] == [{"type": "text", "text": "done"}]


def test_patch_is_idempotent():
    install_litellm_thinking_patch()
    install_litellm_thinking_patch()
    from langchain_litellm.chat_models.litellm import _convert_message_to_dict

    msg = AIMessage(content=[{"type": "thinking", "thinking": "x"}])
    assert _convert_message_to_dict(msg)["content"] == ""


def test_patch_preserves_tool_calls_and_other_roles():
    install_litellm_thinking_patch()
    from langchain_litellm.chat_models.litellm import _convert_message_to_dict

    ai = AIMessage(
        content=[{"type": "thinking", "thinking": "x"}],
        tool_calls=[{"name": "get_price", "args": {"symbol": "NVDA"}, "id": "c1", "type": "tool_call"}],
    )
    out = _convert_message_to_dict(ai)
    assert out["role"] == "assistant"
    assert out["tool_calls"][0]["function"]["name"] == "get_price"

    assert _convert_message_to_dict(HumanMessage(content="hi"))["content"] == "hi"
    tool_out = _convert_message_to_dict(ToolMessage(content="123.45", tool_call_id="c1"))
    assert tool_out["role"] == "tool" and tool_out["content"] == "123.45"
