"""A hung provider call must surface as an error instead of an eternal wait,
so every chat model TradingAgents builds carries a timeout and bounded retries."""

from __future__ import annotations

import pytest

from app.services.agents.llm_timeouts import (
    LLM_MAX_RETRIES,
    LLM_TIMEOUT_S,
    install_llm_timeout_patch,
    llm_timeout_kwargs,
)


@pytest.mark.parametrize(
    ("provider", "timeout_key"),
    [
        ("anthropic", "timeout"),
        ("openai", "timeout"),
        ("openrouter", "timeout"),
        ("google_genai", "timeout"),
        ("litellm", "request_timeout"),
    ],
)
def test_timeout_kwargs_use_each_providers_field_name(provider: str, timeout_key: str) -> None:
    assert llm_timeout_kwargs(provider) == {timeout_key: LLM_TIMEOUT_S, "max_retries": LLM_MAX_RETRIES}


def test_unknown_provider_gets_no_kwargs() -> None:
    assert llm_timeout_kwargs("ollama") == {}


@pytest.mark.parametrize(
    ("provider", "model", "env_key", "timeout_attr"),
    [
        ("anthropic", "claude-sonnet-4-6", "ANTHROPIC_API_KEY", "default_request_timeout"),
        ("openai", "gpt-4o", "OPENAI_API_KEY", "request_timeout"),
        ("litellm", "deepseek/deepseek-v4-pro", "DEEPSEEK_API_KEY", "request_timeout"),
        ("google_genai", "gemini-2.5-pro", "GOOGLE_API_KEY", "timeout"),
    ],
)
def test_models_built_by_tradingagents_carry_timeout_and_retries(
    monkeypatch: pytest.MonkeyPatch, provider: str, model: str, env_key: str, timeout_attr: str,
) -> None:
    monkeypatch.setenv(env_key, "test-key")
    install_llm_timeout_patch()
    install_llm_timeout_patch()

    from tradingagents.llm import build_chat_model

    llm = build_chat_model(provider, model)
    assert getattr(llm, timeout_attr) == LLM_TIMEOUT_S
    assert llm.max_retries == LLM_MAX_RETRIES
