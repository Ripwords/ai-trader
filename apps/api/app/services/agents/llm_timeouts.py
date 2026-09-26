"""Timeouts and bounded retries for every chat model TradingAgents builds."""

from __future__ import annotations

from typing import Any

# A hung provider call otherwise holds a debate open forever. 180 s covers a
# slow reasoning turn; two retries absorb transient 5xx/overloaded errors.
LLM_TIMEOUT_S = 180.0
LLM_MAX_RETRIES = 2

# Keyed by TradingAgents provider name (llm_config maps OpenRouter to
# "openai"). The field names differ per client: ChatLiteLLM has no
# ``timeout`` alias for ``request_timeout``.
_TIMEOUT_FIELD = {
    "anthropic": "timeout",
    "openai": "timeout",
    "google_genai": "timeout",
    "litellm": "request_timeout",
}

_TIMEOUT_PATCH_FLAG = "_ai_trader_timeout_patch_installed"


def llm_timeout_kwargs(ta_provider: str) -> dict[str, Any]:
    field = _TIMEOUT_FIELD.get(ta_provider)
    if field is None:
        return {}
    return {field: LLM_TIMEOUT_S, "max_retries": LLM_MAX_RETRIES}


def install_llm_timeout_patch() -> None:
    """Give every chat model TradingAgents builds a timeout and bounded retries.

    ``tradingagents.llm.build_chat_model`` accepts no client kwargs, so this
    wraps the two constructors it calls. Idempotent.
    """
    import tradingagents.llm as ta_llm

    if getattr(ta_llm.init_chat_model, _TIMEOUT_PATCH_FLAG, False):
        return
    original_init = ta_llm.init_chat_model
    original_google = ta_llm.NormalizedChatGoogleGenerativeAI

    def init_chat_model(model: str, *, model_provider: str, **kwargs: Any) -> Any:
        return original_init(
            model, model_provider=model_provider, **{**llm_timeout_kwargs(model_provider), **kwargs}
        )

    def google_chat_model(**kwargs: Any) -> Any:
        return original_google(**{**llm_timeout_kwargs("google_genai"), **kwargs})

    setattr(init_chat_model, _TIMEOUT_PATCH_FLAG, True)
    ta_llm.init_chat_model = init_chat_model
    ta_llm.NormalizedChatGoogleGenerativeAI = google_chat_model
