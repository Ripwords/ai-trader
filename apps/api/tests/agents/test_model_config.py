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


def test_legacy_deepseek_past_sunset_warns_but_still_parses(monkeypatch, caplog):
    """The sunset date must NOT hard-fail parsing. The retired aliases still
    resolve server-side, so someone with one pinned in LLM_MODEL keeps running;
    past the sunset date we log a loud warning instead of raising. (v4 thinking
    models now work too — see deepseek_compat — so the warning can point at a
    real replacement rather than a dead end.)"""
    import datetime as _dt

    from app.services.agents import model_config as mc

    class _FakeDate(_dt.date):
        @classmethod
        def today(cls) -> "_FakeDate":
            return cls(2026, 12, 1)  # well past the sunset

    monkeypatch.setattr(mc, "date", _FakeDate)
    caplog.set_level(logging.WARNING, logger="app.services.agents.model_config")

    spec = mc.parse_model_spec("deepseek/deepseek-chat")
    assert spec.provider == "deepseek"
    assert spec.model_id == "deepseek-chat"  # parsed, not raised
    assert "retire" in caplog.text.lower()


def test_legacy_deepseek_sunset_extended_to_2026_09_30():
    from datetime import date

    from app.services.agents.model_config import LEGACY_DEEPSEEK_SUNSET

    assert LEGACY_DEEPSEEK_SUNSET == date(2026, 9, 30)


def test_legacy_deepseek_name_warns_but_does_not_rewrite(caplog):
    """We never auto-rewrite a pinned model. Silently swapping deepseek-chat
    for deepseek-v4-flash changes what the user is billed for and what their
    run history means, so we parse the name as given and warn."""
    caplog.set_level(logging.WARNING, logger="app.services.agents.model_config")
    spec = parse_model_spec("deepseek/deepseek-chat")
    assert spec.provider == "deepseek"
    assert spec.model_id == "deepseek-chat"   # NOT rewritten
    assert "retired" in caplog.text.lower() or "will be" in caplog.text.lower()


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


def test_build_config_maps_google_to_google_genai(monkeypatch):
    """TradingAgents' init_chat_model registry uses ``google_genai``; we accept
    the friendlier ``google`` in our env convention and translate."""
    monkeypatch.setenv("LLM_MODEL", "google/gemini-2.5-pro")
    monkeypatch.delenv("LLM_MODEL_QUICK", raising=False)
    cfg = build_tradingagents_config()
    assert cfg["llm_provider"] == "google_genai"
    assert cfg["deep_think_llm"] == "gemini-2.5-pro"
    assert cfg["quick_think_llm"] == "gemini-2.5-flash"


def test_build_config_routes_deepseek_via_litellm(monkeypatch):
    """DeepSeek isn't a native init_chat_model provider; route through litellm
    using its ``deepseek/<model>`` namespace so DEEPSEEK_API_KEY is read
    automatically."""
    monkeypatch.setenv("LLM_MODEL", "deepseek/deepseek-v4-pro")
    monkeypatch.delenv("LLM_MODEL_QUICK", raising=False)
    cfg = build_tradingagents_config()
    assert cfg["llm_provider"] == "litellm"
    assert cfg["deep_think_llm"] == "deepseek/deepseek-v4-pro"
    assert cfg["quick_think_llm"] == "deepseek/deepseek-v4-flash"


def test_legacy_deepseek_warning_names_the_v4_replacement(caplog):
    """The warning has to be actionable. It used to say "migrate when the
    integration is fixed", which named nothing to migrate to; deepseek_compat
    fixed that integration, so the warning now points at a concrete model."""
    caplog.set_level(logging.WARNING, logger="app.services.agents.model_config")
    parse_model_spec("deepseek/deepseek-chat")
    assert "deepseek-v4-flash" in caplog.text

    caplog.clear()
    parse_model_spec("deepseek/deepseek-reasoner")
    assert "deepseek-v4-pro" in caplog.text
