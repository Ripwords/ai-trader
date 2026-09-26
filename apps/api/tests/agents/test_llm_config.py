from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
from pydantic import ValidationError
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

    run_models = llm_config.track_run_models()
    config = await fetch_llm_config()

    assert config.chat == RoleModel(kind="openai", model_id="gpt-5", api_key="sk-chat", base_url=None)
    assert config.quick.model_id == "gpt-5-mini"
    assert seen[0].url == f"{get_settings().WEB_INTERNAL_BASE_URL}/api/internal/llm-config"
    assert seen[0].headers["authorization"] == f"Bearer {get_settings().INTERNAL_BEARER}"
    assert run_models.chat == config.chat


@pytest.mark.asyncio
async def test_each_run_prices_the_model_it_fetched(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two runs overlap while Settings changes between their fetches: each
    keeps its own chat model, as does a child task that builds the graph."""
    served = iter(["claude-sonnet-4-6", "gpt-5"])

    def handler(_request: httpx.Request) -> httpx.Response:
        model = next(served)
        kind = "anthropic" if model.startswith("claude") else "openai"
        chat = {"kind": kind, "model_id": model, "api_key": "k", "base_url": None}
        return httpx.Response(200, json=llm_config_wire(chat=chat))

    monkeypatch.setattr(llm_config, "_transport", httpx.MockTransport(handler))
    first_fetched = asyncio.Event()
    second_fetched = asyncio.Event()

    async def run(fetched: asyncio.Event, wait_for: asyncio.Event | None) -> str | None:
        run_models = llm_config.track_run_models()
        if wait_for is not None:
            await wait_for.wait()
        await asyncio.create_task(fetch_llm_config())
        fetched.set()
        if wait_for is None:
            await second_fetched.wait()
        return run_models.chat.model_id if run_models.chat else None

    first, second = await asyncio.gather(run(first_fetched, None), run(second_fetched, first_fetched))

    assert (first, second) == ("claude-sonnet-4-6", "gpt-5")


@pytest.mark.asyncio
async def test_fetch_outside_a_run_still_returns_the_config() -> None:
    config = await asyncio.create_task(fetch_llm_config())
    assert config.chat.model_id == "claude-sonnet-4-6"


@pytest.mark.asyncio
async def test_fetch_raises_a_readable_error_when_nothing_is_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _serve(monkeypatch, 409, {"statusMessage": "llm_not_configured"}, [])
    with pytest.raises(LlmNotConfigured, match="Add one in Settings"):
        await fetch_llm_config()


@pytest.mark.asyncio
async def test_fetch_passes_on_web_s_explanation_for_an_unreadable_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = {
        "statusCode": 409,
        "statusMessage": "llm_key_unreadable",
        "message": "A stored API key could not be decrypted. Open Settings and re-enter its key.",
        "data": {"code": "llm_key_unreadable"},
    }
    _serve(monkeypatch, 409, body, [])
    with pytest.raises(LlmNotConfigured, match="re-enter its key"):
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


def test_only_online_providers_with_a_key_are_accepted() -> None:
    with pytest.raises(ValidationError):
        _role("openai_compatible", base_url="http://ollama:11434/v1")
    with pytest.raises(ValidationError):
        _role("openai", api_key=None)


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
    gateway = build_role_model(_role("openrouter"), reasoning_effort="high")
    assert isinstance(gateway, ChatOpenAI)
    assert gateway.reasoning_effort is None


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
        quick=_role("openrouter", base_url="https://gateway.example/v1"),
    )
    ta = build_graph(None, models=config, results_dir=tmp_path)
    assert isinstance(ta.deep_thinking_llm, ChatAnthropic)
    assert ta.deep_thinking_llm.anthropic_api_key.get_secret_value() == "sk-test"
    assert isinstance(ta.quick_thinking_llm, ChatOpenAI)
    assert ta.quick_thinking_llm.openai_api_base == "https://gateway.example/v1"


def test_build_graph_without_deep_thinking_uses_an_effort_tradingagents_accepts(tmp_path: Any) -> None:
    from app.services.agents.graph import build_graph
    from app.services.agents.llm_config import LlmRuntimeConfig

    config = LlmRuntimeConfig(chat=_role("anthropic"), quick=_role("anthropic"))
    ta = build_graph(None, models=config, results_dir=tmp_path, deep_thinking=False)
    assert ta.config.reasoning_effort == "low"
