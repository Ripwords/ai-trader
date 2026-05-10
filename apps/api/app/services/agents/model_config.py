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
        quick_model = quick.model_id
    else:
        quick_model = default_quick_for(deep.provider, deep.model_id)

    return {
        "llm_provider": deep.provider,
        "deep_think_llm": deep.model_id,
        "quick_think_llm": quick_model,
        "anthropic_effort": "medium",
        "openai_reasoning_effort": "medium",
    }
