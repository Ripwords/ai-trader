from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import date

logger = logging.getLogger(__name__)

LEGACY_DEEPSEEK_SUNSET = date(2026, 7, 24)
LEGACY_DEEPSEEK_ALIASES = {
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-pro",
}

QUICK_FALLBACK_MAP = {
    ("anthropic", "claude-sonnet-4-6"): "claude-haiku-4-5-20251001",
    ("anthropic", "claude-opus-4-7"): "claude-haiku-4-5-20251001",
    ("openai", "gpt-4o"): "gpt-4o-mini",
    ("google", "gemini-2.5-pro"): "gemini-2.5-flash",
    ("deepseek", "deepseek-v4-pro"): "deepseek-v4-flash",
}

QUICK_FAMILY_FALLBACK = {
    "anthropic": "claude-haiku-4-5-20251001",
    "openai": "gpt-4o-mini",
    "google": "gemini-2.5-flash",
    "deepseek": "deepseek-v4-flash",
}


class SameProviderViolation(ValueError):
    pass


@dataclass(frozen=True)
class ModelSpec:
    provider: str
    model_id: str


def parse_model_spec(spec: str) -> ModelSpec:
    if "/" not in spec:
        raise ValueError(f"Expected provider/model format, got: {spec!r}")
    provider, model_id = spec.split("/", 1)
    provider = provider.strip().lower()
    model_id = model_id.strip()

    if provider == "deepseek" and model_id in LEGACY_DEEPSEEK_ALIASES:
        if date.today() >= LEGACY_DEEPSEEK_SUNSET:
            raise ValueError(
                f"DeepSeek alias {model_id!r} retired on {LEGACY_DEEPSEEK_SUNSET.isoformat()}; "
                f"use {LEGACY_DEEPSEEK_ALIASES[model_id]!r}"
            )
        replacement = LEGACY_DEEPSEEK_ALIASES[model_id]
        logger.warning(
            "DeepSeek model %r is deprecated and will be removed on %s. "
            "Use %r instead. Auto-routing to %r for now.",
            model_id,
            LEGACY_DEEPSEEK_SUNSET.isoformat(),
            replacement,
            replacement,
        )
        model_id = replacement

    return ModelSpec(provider=provider, model_id=model_id)


def default_quick_for(provider: str, deep_model: str) -> str:
    explicit = QUICK_FALLBACK_MAP.get((provider, deep_model))
    if explicit:
        return explicit
    family = QUICK_FAMILY_FALLBACK.get(provider)
    if family:
        return family
    raise ValueError(f"No quick fallback for provider {provider!r}")


# Map our env-var convention names to TradingAgents' LangChain
# init_chat_model registry keys. We use friendlier short names (``google``,
# ``deepseek``) in ``LLM_MODEL`` so the env stays consistent with web's
# Vercel-AI-SDK conventions; TradingAgents requires its own enum values.
_TA_PROVIDER_MAP = {
    "anthropic": "anthropic",
    "openai": "openai",
    "google": "google_genai",
    # DeepSeek's API is OpenAI-compatible; LangChain's ``init_chat_model``
    # exposes it through the litellm provider, which natively understands the
    # ``deepseek/<model>`` namespace and reads ``DEEPSEEK_API_KEY`` from env.
    "deepseek": "litellm",
}


def build_tradingagents_config() -> dict:
    deep = parse_model_spec(os.environ["LLM_MODEL"])
    quick_env = os.environ.get("LLM_MODEL_QUICK")
    if quick_env:
        quick = parse_model_spec(quick_env)
        if quick.provider != deep.provider:
            raise SameProviderViolation(
                f"LLM_MODEL_QUICK provider {quick.provider!r} must equal "
                f"LLM_MODEL provider {deep.provider!r} (mixed-provider not supported in v1)"
            )
        quick_model_id = quick.model_id
    else:
        quick_model_id = default_quick_for(deep.provider, deep.model_id)

    ta_provider = _TA_PROVIDER_MAP.get(deep.provider)
    if ta_provider is None:
        raise ValueError(
            f"Provider {deep.provider!r} is not supported by TradingAgents. "
            f"Supported: {sorted(_TA_PROVIDER_MAP)}"
        )

    # LiteLLM expects ``<provider>/<model>``; native providers expect just
    # the model id. Restore the namespace prefix only for litellm-routed ones.
    if ta_provider == "litellm":
        deep_model = f"{deep.provider}/{deep.model_id}"
        quick_model = f"{deep.provider}/{quick_model_id}"
    else:
        deep_model = deep.model_id
        quick_model = quick_model_id

    return {
        "llm_provider": ta_provider,
        "deep_think_llm": deep_model,
        "quick_think_llm": quick_model,
        "anthropic_effort": "medium",
        "openai_reasoning_effort": "medium",
    }
