from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from langchain_anthropic import ChatAnthropic
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_litellm import ChatLiteLLM
from langchain_openai import ChatOpenAI
from tradingagents import llm as ta_llm

from app.services.agents import llm_config
from app.services.agents.llm_config import (
    LlmNotConfigured,
    RoleModel,
    build_role_model,
    fetch_llm_config,
)
from app.settings import get_settings
from tests.conftest import llm_config_wire


def _serve(monkeypatch: pytest.MonkeyPatch, status: int, body: Any, seen: list[httpx.Request]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, content=json.dumps(body))

    monkeypatch.setattr(llm_config, "_transport", httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_reads_both_roles_with_the_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[httpx.Request] = []
    wire = llm_config_wire(
        chat={"kind": "openai", "model_id": "gpt-5", "api_key": "sk-chat", "base_url": None},
        quick={"kind": "openai", "model_id": "gpt-5-mini", "api_key": "sk-chat", "base_url": None},
    )
    _serve(monkeypatch, 200, wire, seen)

    config = await fetch_llm_config()

    assert config.chat == RoleModel(kind="openai", model_id="gpt-5", api_key="sk-chat", base_url=None)
    assert config.quick.model_id == "gpt-5-mini"
    assert seen[0].url == f"{get_settings().WEB_INTERNAL_BASE_URL}/api/internal/llm-config"
    assert seen[0].headers["authorization"] == f"Bearer {get_settings().INTERNAL_BEARER}"
    assert llm_config.last_chat_model() == config.chat


@pytest.mark.asyncio
async def test_fetch_raises_a_readable_error_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _serve(monkeypatch, 409, {"statusMessage": "llm_not_configured"}, [])
    with pytest.raises(LlmNotConfigured, match="Add one in Settings"):
        await fetch_llm_config()


def _role(kind: str, *, api_key: str | None = "sk-test", base_url: str | None = None) -> RoleModel:
    return RoleModel.model_validate({"kind": kind, "model_id": "m-1", "api_key": api_key, "base_url": base_url})


def test_anthropic_gets_key_and_base_url_without_the_sdk_version_suffix() -> None:
    model = build_role_model(_role("anthropic", base_url="https://proxy.example/v1"))
    assert isinstance(model, ChatAnthropic)
    assert model.anthropic_api_key.get_secret_value() == "sk-test"
    assert model.anthropic_api_url == "https://proxy.example"


def test_openai_gets_key_and_base_url() -> None:
    model = build_role_model(_role("openai", base_url="https://gateway.example/v1"))
    assert isinstance(model, ChatOpenAI)
    assert model.openai_api_key is not None
    assert model.openai_api_key.get_secret_value() == "sk-test"
    assert model.openai_api_base == "https://gateway.example/v1"


def test_openrouter_defaults_to_the_openrouter_endpoint() -> None:
    model = build_role_model(_role("openrouter"))
    assert isinstance(model, ChatOpenAI)
    assert model.openai_api_base == "https://openrouter.ai/api/v1"


def test_openai_compatible_runs_without_a_key() -> None:
    model = build_role_model(_role("openai_compatible", api_key=None, base_url="http://ollama:11434/v1"))
    assert isinstance(model, ChatOpenAI)
    assert model.openai_api_base == "http://ollama:11434/v1"


def test_google_gets_key_and_base_url_without_the_api_version() -> None:
    model = build_role_model(_role("google", base_url="https://gemini-proxy.example/v1beta"))
    assert isinstance(model, ChatGoogleGenerativeAI)
    assert model.google_api_key is not None
    assert model.google_api_key.get_secret_value() == "sk-test"
    assert model.base_url == "https://gemini-proxy.example"


def test_deepseek_routes_through_litellm_with_a_per_call_key() -> None:
    model = build_role_model(_role("deepseek", base_url="https://api.deepseek.com/v1"))
    assert isinstance(model, ChatLiteLLM)
    assert model.model == "deepseek/m-1"
    assert model.api_base == "https://api.deepseek.com/v1"
    assert model.model_kwargs["api_key"] == "sk-test"


def test_reasoning_effort_maps_to_the_native_knob_only_for_native_providers() -> None:
    anthropic = build_role_model(_role("anthropic"), reasoning_effort="high")
    assert isinstance(anthropic, ChatAnthropic)
    assert anthropic.effort == "high"
    local = build_role_model(_role("openai_compatible", base_url="http://ollama:11434/v1"), reasoning_effort="high")
    assert isinstance(local, ChatOpenAI)
    assert local.reasoning_effort is None


def test_models_are_built_through_tradingagents_init_chat_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patches on ``tradingagents.llm.init_chat_model`` (the LLM timeout) must apply."""
    calls: list[dict[str, Any]] = []
    real = ta_llm.init_chat_model

    def spy(model: str, **kwargs: Any) -> Any:
        calls.append({"model": model, **kwargs})
        return real(model, **kwargs)

    monkeypatch.setattr(ta_llm, "init_chat_model", spy)
    build_role_model(_role("openai"))
    assert calls[0]["model_provider"] == "openai"


def test_build_graph_gives_the_chat_role_to_deep_agents_and_quick_to_fast_ones(tmp_path: Any) -> None:
    from app.services.agents.graph import build_graph
    from app.services.agents.llm_config import LlmRuntimeConfig

    config = LlmRuntimeConfig(
        chat=_role("anthropic"),
        quick=_role("openai_compatible", api_key=None, base_url="http://ollama:11434/v1"),
    )
    ta = build_graph(None, models=config, results_dir=tmp_path)
    assert isinstance(ta.deep_thinking_llm, ChatAnthropic)
    assert ta.deep_thinking_llm.anthropic_api_key.get_secret_value() == "sk-test"
    assert isinstance(ta.quick_thinking_llm, ChatOpenAI)
    assert ta.quick_thinking_llm.openai_api_base == "http://ollama:11434/v1"


def test_build_graph_without_deep_thinking_uses_an_effort_tradingagents_accepts(tmp_path: Any) -> None:
    from app.services.agents.graph import build_graph
    from app.services.agents.llm_config import LlmRuntimeConfig

    config = LlmRuntimeConfig(chat=_role("anthropic"), quick=_role("anthropic"))
    ta = build_graph(None, models=config, results_dir=tmp_path, deep_thinking=False)
    assert ta.config.reasoning_effort == "low"
