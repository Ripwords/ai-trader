import logging

import pytest

from app.services.agents.model_config import (
    SameProviderViolation,
    build_tradingagents_config,
    default_quick_for,
    parse_model_spec,
)


def test_parse_anthropic():
    spec = parse_model_spec("anthropic/claude-sonnet-4-6")
    assert spec.provider == "anthropic"
    assert spec.model_id == "claude-sonnet-4-6"


def test_parse_rejects_missing_provider():
    with pytest.raises(ValueError, match="provider/model"):
        parse_model_spec("claude-sonnet-4-6")


def test_default_quick_anthropic():
    assert default_quick_for("anthropic", "claude-sonnet-4-6") == "claude-haiku-4-5-20251001"


def test_default_quick_openai_flagship():
    assert default_quick_for("openai", "gpt-4o") == "gpt-4o-mini"


def test_default_quick_google_pro():
    assert default_quick_for("google", "gemini-2.5-pro") == "gemini-2.5-flash"


def test_default_quick_deepseek_v4():
    assert default_quick_for("deepseek", "deepseek-v4-pro") == "deepseek-v4-flash"


def test_legacy_deepseek_alias_warns(caplog):
    caplog.set_level(logging.WARNING, logger="app.services.agents.model_config")
    spec = parse_model_spec("deepseek/deepseek-reasoner")
    assert spec.provider == "deepseek"
    assert "deprecated" in caplog.text.lower()


def test_build_config_uses_env(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")
    monkeypatch.delenv("LLM_MODEL_QUICK", raising=False)
    cfg = build_tradingagents_config()
    assert cfg["llm_provider"] == "anthropic"
    assert cfg["deep_think_llm"] == "claude-sonnet-4-6"
    assert cfg["quick_think_llm"] == "claude-haiku-4-5-20251001"


def test_same_provider_constraint(monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")
    monkeypatch.setenv("LLM_MODEL_QUICK", "openai/gpt-4o-mini")
    with pytest.raises(SameProviderViolation):
        build_tradingagents_config()
