"""LangChain callback that accumulates token usage across a run.

LangGraph runs make many LLM calls; the wire-level ``run-end`` event needs
the *sum* of prompt/completion tokens so we can report cost. LangChain's
``AsyncCallbackHandler`` is the per-call hook — instances are passed via
``config={"callbacks": [...]}`` to the graph's ``astream`` and LangChain
invokes ``on_llm_end`` for every LLM completion (including those nested in
tool-calling chains).

LangChain normalises usage in two shapes depending on the provider:

* OpenAI: ``llm_output['token_usage']`` with ``prompt_tokens`` /
  ``completion_tokens`` (some langchain-openai versions surface a sibling
  ``llm_output['usage']`` with ``input_tokens`` / ``output_tokens`` instead).
* Anthropic / Gemini / Bedrock-via-langchain: per-generation
  ``message.usage_metadata`` with ``input_tokens`` / ``output_tokens``.

We try both shapes; if neither is present we record nothing (this is what
LangChain does internally when a provider doesn't surface usage).
"""

from __future__ import annotations

from typing import Any

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.outputs import LLMResult


def _coerce_int(value: Any) -> int:
    """Coerce a usage-counter value to int. Returns 0 for falsy/non-numeric."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class UsageAccumulator(AsyncCallbackHandler):
    """LangChain callback that sums token usage across LLM calls in a run.

    One instance per LangGraph run. Pass it via
    ``config={"callbacks": [accumulator]}`` to ``astream`` and read
    :attr:`tokens_in` / :attr:`tokens_out` after the stream ends to feed
    ``run-end``'s totals.
    """

    def __init__(self) -> None:
        self.tokens_in: int = 0
        self.tokens_out: int = 0

    async def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        # Try llm_output["token_usage"] (OpenAI-style) or llm_output["usage"]
        # (some adapters) first. If usage is reported there, we trust it and
        # skip the per-generation scan.
        llm_output = response.llm_output or {}
        usage = llm_output.get("token_usage") or llm_output.get("usage")
        if usage:
            prompt = usage.get("prompt_tokens") or usage.get("input_tokens")
            completion = usage.get("completion_tokens") or usage.get("output_tokens")
            self.tokens_in += _coerce_int(prompt)
            self.tokens_out += _coerce_int(completion)
            return

        # Fallback: scan generations for usage_metadata (Anthropic shape).
        for gen_list in response.generations or []:
            for gen in gen_list:
                msg = getattr(gen, "message", None)
                meta = getattr(msg, "usage_metadata", None) if msg is not None else None
                if meta:
                    self.tokens_in += _coerce_int(meta.get("input_tokens"))
                    self.tokens_out += _coerce_int(meta.get("output_tokens"))
