"""Make DeepSeek's v4 thinking models survive LangGraph's tool-calling loop.

DeepSeek retired the non-thinking ``deepseek-chat`` / ``deepseek-reasoner``
aliases; ``GET /models`` now lists only ``deepseek-v4-pro``,
``deepseek-v4-flash`` and ``deepseek-v4-flash-vision-exp``, all of which run in
thinking mode. So "just pin the legacy model" is no longer an option and the
thinking-mode round-trip has to actually work.

The failure it fixes
--------------------
LangChain surfaces a thinking model's reasoning as a content *block*, so an
``AIMessage`` comes back as::

    content=[{"type": "thinking", "thinking": "..."},
             {"type": "text", "text": "..."}]

``langchain_litellm._convert_message_to_dict`` drops ``tool_use``/``tool_call``
blocks but passes every other unrecognised dict through unchanged. On the next
turn that block is serialised straight back into ``messages[].content`` and
DeepSeek rejects the request outright::

    litellm.BadRequestError: DeepseekException - Failed to deserialize the JSON
    body into the target type: messages[1]: unknown variant `thinking`,
    expected one of `text`, `image_url`, `file`

which breaks the second turn of every assistant -> tool_call -> tool_result ->
assistant loop, i.e. every agents run.

Reasoning blocks are display/provenance only — the DeepSeek API does not want
them echoed back, and dropping them loses nothing the next turn needs. We strip
them on the way out rather than at the graph level because TradingAgents builds
its own chat models internally, so this is the one chokepoint every
litellm-routed request passes through.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Block types that carry model reasoning rather than user-visible content.
# ``thinking`` is what LangChain emits for DeepSeek; the rest are the spellings
# other providers use, dropped too so a provider swap cannot resurrect this bug.
REASONING_BLOCK_TYPES = frozenset(
    {"thinking", "reasoning", "reasoning_content", "redacted_thinking"}
)

_PATCH_FLAG = "_ai_trader_thinking_patch_installed"


def strip_reasoning_blocks(content: Any) -> Any:
    """Drop reasoning blocks from a message ``content`` value.

    Non-list content (the ordinary plain-string case) is returned untouched.
    A list that contains nothing but reasoning collapses to ``""`` rather than
    ``[]``, matching what langchain_litellm does when its own filtering empties
    the list — providers reject an empty content array.
    """
    if not isinstance(content, list):
        return content
    kept = [
        item
        for item in content
        if not (isinstance(item, dict) and item.get("type") in REASONING_BLOCK_TYPES)
    ]
    if len(kept) == len(content):
        return content
    return kept or ""


def install_litellm_thinking_patch() -> None:
    """Wrap ``langchain_litellm``'s message converter to strip reasoning blocks.

    Idempotent — safe to call from every graph build. A no-op (logged) if
    langchain_litellm is absent or its internals have moved, so a non-DeepSeek
    deployment never fails to start over this.
    """
    try:
        from langchain_litellm.chat_models import litellm as _litellm_chat
    except ImportError:  # pragma: no cover - langchain_litellm always installed here
        logger.debug("langchain_litellm not installed; skipping thinking-block patch")
        return

    original = getattr(_litellm_chat, "_convert_message_to_dict", None)
    if original is None:  # pragma: no cover - upstream rename
        logger.warning(
            "langchain_litellm._convert_message_to_dict is missing; DeepSeek "
            "thinking blocks will not be stripped and multi-turn tool calls "
            "will fail. Upstream internals likely changed."
        )
        return
    if getattr(original, _PATCH_FLAG, False):
        return

    def _convert_message_to_dict(message: Any) -> dict:
        result = original(message)
        if isinstance(result, dict) and "content" in result:
            result["content"] = strip_reasoning_blocks(result["content"])
        return result

    setattr(_convert_message_to_dict, _PATCH_FLAG, True)
    _convert_message_to_dict.__doc__ = original.__doc__
    _litellm_chat._convert_message_to_dict = _convert_message_to_dict
    logger.info("Installed langchain_litellm reasoning-block strip patch")
