from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import date

logger = logging.getLogger(__name__)

LEGACY_DEEPSEEK_SUNSET = date(2026, 9, 30)
# Retired DeepSeek names. As of 2026-09-05 these are gone from ``GET /models``
# (which lists only deepseek-v4-pro, deepseek-v4-flash and
# deepseek-v4-flash-vision-exp) though they still resolve server-side, routed
# to a v4 thinking model.
#
# These names used to be load-bearing: v4 runs in thinking mode, and thinking
# mode broke LangGraph's tool loop, so the non-thinking aliases were the only
# DeepSeek models the agents pipeline could use. That is fixed —
# ``deepseek_compat.install_litellm_thinking_patch`` strips the reasoning
# content blocks that DeepSeek rejects on echo-back, and v4-pro/v4-flash now
# complete multi-turn tool loops. The aliases are kept parseable so an existing
# LLM_MODEL keeps working, with a warning pointing at the v4 replacement.
#
# Still no auto-rewrite: silently swapping the model someone pinned changes
# what they are billed for and what their run history means. Warn, don't guess.
LEGACY_DEEPSEEK_NAMES = {"deepseek-chat", "deepseek-reasoner"}

# What to tell someone still pinning a retired alias.
LEGACY_DEEPSEEK_REPLACEMENT = {
    "deepseek-chat": "deepseek-v4-flash",
    "deepseek-reasoner": "deepseek-v4-pro",
}

QUICK_FALLBACK_MAP = {
    ("anthropic", "claude-sonnet-4-6"): "claude-haiku-4-5-20251001",
    ("anthropic", "claude-opus-4-7"): "claude-haiku-4-5-20251001",
    ("openai", "gpt-4o"): "gpt-4o-mini",
    ("google", "gemini-2.5-pro"): "gemini-2.5-flash",
    ("deepseek", "deepseek-v4-pro"): "deepseek-v4-flash",
    # Retired DeepSeek pair: stays self-consistent so a pinned
    # LLM_MODEL=deepseek/deepseek-chat produces a deepseek-chat quick model too
    # rather than silently mixing a retired deep model with a v4 quick one.
    ("deepseek", "deepseek-chat"): "deepseek-chat",
    ("deepseek", "deepseek-reasoner"): "deepseek-reasoner",
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

    if provider == "deepseek" and model_id in LEGACY_DEEPSEEK_NAMES:
        # Loud warning, never a hard failure and never a silent rewrite: the
        # alias still resolves, so an existing pin keeps working.
        replacement = LEGACY_DEEPSEEK_REPLACEMENT.get(model_id, "deepseek-v4-flash")
        if date.today() >= LEGACY_DEEPSEEK_SUNSET:
            logger.warning(
                "DeepSeek model %r is PAST its announced retirement date (%s), "
                "is no longer listed in GET /models, and may stop resolving at "
                "any moment. Switch LLM_MODEL to deepseek/%s — v4 thinking "
                "models now work with the agents pipeline.",
                model_id, LEGACY_DEEPSEEK_SUNSET.isoformat(), replacement,
            )
        else:
            logger.warning(
                "DeepSeek model %r is retired on %s; switch LLM_MODEL to "
                "deepseek/%s.",
                model_id, LEGACY_DEEPSEEK_SUNSET.isoformat(), replacement,
            )

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


def build_tradingagents_config(
    *,
    reasoning_effort: str = "medium",
    response_language: str = "en-US",
) -> dict:
    """Translate our env-convention model spec + per-run knobs into the dict
    TradingAgents' ``TradingAgentsConfig`` accepts.

    ``reasoning_effort`` and ``response_language`` come from the per-request
    body (defaults match :class:`app.schemas.agents.RunRequest`); the rest is
    sourced from process env (``LLM_MODEL``, ``LLM_MODEL_QUICK``).
    """
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
        # TradingAgents reads ``reasoning_effort`` directly and maps to the
        # provider-native knob inside its ``build_chat_model`` (Anthropic →
        # ``effort``, OpenAI → ``reasoning_effort``, Google → ``thinking_level``).
        "reasoning_effort": reasoning_effort,
        "response_language": response_language,
        # Legacy fields some of TradingAgents' agent prompts still read; kept
        # for compatibility with older versions of the upstream.
        "anthropic_effort": reasoning_effort,
        "openai_reasoning_effort": reasoning_effort,
    }
