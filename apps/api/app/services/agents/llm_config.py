"""The debate's models, as chosen in the web app's Settings.

Web owns the provider table and the encrypted keys. Each run reads the chat
and quick roles, keys decrypted, over the bearer-guarded internal route, and
hands every key to its model object directly. Nothing is written to
``os.environ``, so two runs never see each other's credentials.
"""

from __future__ import annotations

import re
from typing import Any, Literal

import httpx
import tradingagents.llm as ta_llm
from langchain_core.language_models.chat_models import BaseChatModel
from pydantic import BaseModel

from app.settings import get_settings

from .llm_timeouts import install_llm_timeout_patch

ProviderKind = Literal["anthropic", "openai", "google", "deepseek", "openrouter", "openai_compatible"]


class RoleModel(BaseModel):
    kind: ProviderKind
    model_id: str
    api_key: str | None
    # Null means the provider's default endpoint.
    base_url: str | None


class LlmRuntimeConfig(BaseModel):
    chat: RoleModel
    quick: RoleModel


class LlmNotConfigured(RuntimeError):
    pass


# Tests swap in an ``httpx.MockTransport``.
_transport: httpx.AsyncBaseTransport | None = None
_last_chat: RoleModel | None = None


async def fetch_llm_config() -> LlmRuntimeConfig:
    global _last_chat
    settings = get_settings()
    async with httpx.AsyncClient(transport=_transport, timeout=15) as client:
        res = await client.get(
            f"{settings.WEB_INTERNAL_BASE_URL}/api/internal/llm-config",
            headers={"authorization": f"Bearer {settings.INTERNAL_BEARER}"},
        )
    if res.status_code == 409:
        raise LlmNotConfigured("No model provider is configured. Add one in Settings.")
    res.raise_for_status()
    config = LlmRuntimeConfig.model_validate(res.json())
    _last_chat = config.chat
    return config


def last_chat_model() -> RoleModel | None:
    """The chat model the most recent run started with, used to price it.

    A Settings change while a run is in flight prices that run at the new
    model's rates.
    """
    return _last_chat


# TradingAgents' ``init_chat_model`` registry key per kind. DeepSeek goes
# through litellm so ``deepseek_compat``'s thinking-mode patch applies;
# OpenRouter and local servers speak the OpenAI API.
_TA_PROVIDER: dict[ProviderKind, ta_llm.LLMProvider] = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google_genai",
    "deepseek": "litellm",
    "openrouter": "openai",
    "openai_compatible": "openai",
}

# Kinds whose client exposes TradingAgents' unified reasoning knob.
_REASONING_KINDS: frozenset[ProviderKind] = frozenset({"anthropic", "openai", "google"})

_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def ta_provider(kind: ProviderKind) -> ta_llm.LLMProvider:
    return _TA_PROVIDER[kind]


def _without_version(url: str) -> str:
    """Web's SDKs take base URLs ending in the API version; LangChain's
    Anthropic and Google clients append their own."""
    return re.sub(r"/v1(beta)?/?$", "", url)


def build_role_model(
    role: RoleModel, *, reasoning_effort: str | None = None, **kwargs: Any
) -> BaseChatModel:
    """Construct the chat model for one role.

    Goes through ``tradingagents.llm``'s constructors, looked up at call time,
    so patches installed on them (timeouts, retries) apply here too.
    """
    install_llm_timeout_patch()
    provider = _TA_PROVIDER[role.kind]
    if reasoning_effort and role.kind in _REASONING_KINDS:
        ta_llm._apply_reasoning(provider, reasoning_effort, kwargs)
    base_url = role.base_url

    if role.kind == "google":
        if base_url:
            kwargs["base_url"] = _without_version(base_url)
        return ta_llm.NormalizedChatGoogleGenerativeAI(model=role.model_id, api_key=role.api_key, **kwargs)

    if role.kind == "deepseek":
        # ChatLiteLLM sets ``api_key`` on the litellm module, shared by every
        # run; ``model_kwargs`` reaches each completion call instead.
        if base_url:
            kwargs["api_base"] = base_url
        return ta_llm.init_chat_model(
            f"deepseek/{role.model_id}",
            model_provider=provider,
            model_kwargs={"api_key": role.api_key},
            **kwargs,
        )

    if role.kind == "anthropic":
        if base_url:
            kwargs["base_url"] = _without_version(base_url)
    elif role.kind == "openrouter":
        kwargs["base_url"] = base_url or _OPENROUTER_BASE_URL
    elif base_url:
        kwargs["base_url"] = base_url
    # Local servers take no key, but the OpenAI client refuses to start without one.
    api_key = role.api_key or "not-needed"
    return ta_llm.init_chat_model(role.model_id, model_provider=provider, api_key=api_key, **kwargs)
