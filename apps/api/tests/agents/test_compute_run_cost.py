"""Tests for the router-level run-cost computation.

The invariant under test: a run with non-zero token usage must NEVER be
priced at $0.00. An unknown model, a provider with no pricing table, or no
run having fetched its models falls back to conservative (env-overridable)
rates instead of silently free-riding under the daily cap.
"""

from __future__ import annotations

import httpx
import pytest

from app.routers.agents import _compute_run_cost
from app.services.agents import llm_config
from app.settings import get_settings
from tests.conftest import llm_config_wire


@pytest.fixture(autouse=True)
def _fresh_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _start_run_with_chat(monkeypatch: pytest.MonkeyPatch, kind: str, model_id: str) -> None:
    wire = llm_config_wire(chat={"kind": kind, "model_id": model_id, "api_key": "k", "base_url": None})
    monkeypatch.setattr(
        llm_config, "_transport", httpx.MockTransport(lambda _r: httpx.Response(200, json=wire))
    )
    await llm_config.fetch_llm_config()


@pytest.mark.asyncio
async def test_known_model_uses_pricing_table(monkeypatch: pytest.MonkeyPatch) -> None:
    await _start_run_with_chat(monkeypatch, "anthropic", "claude-sonnet-4-6")
    # 1M in @ $3 + 1M out @ $15
    assert _compute_run_cost(1_000_000, 1_000_000) == pytest.approx(18.0)


@pytest.mark.asyncio
async def test_unknown_model_uses_fallback_rates(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    await _start_run_with_chat(monkeypatch, "anthropic", "model-that-does-not-exist")
    monkeypatch.setenv("AGENTS_FALLBACK_INPUT_USD_PER_1M", "10.0")
    monkeypatch.setenv("AGENTS_FALLBACK_OUTPUT_USD_PER_1M", "20.0")
    get_settings.cache_clear()
    with caplog.at_level("WARNING", logger="app.routers.agents"):
        cost = _compute_run_cost(1_000_000, 500_000)
    assert cost == pytest.approx(10.0 + 10.0)
    assert "fallback" in caplog.text.lower()


@pytest.mark.asyncio
async def test_unpriced_provider_uses_fallback_rates(monkeypatch: pytest.MonkeyPatch) -> None:
    await _start_run_with_chat(monkeypatch, "openrouter", "qwen/qwen3-32b")
    # Default conservative fallback: $15 per 1M input tokens.
    assert _compute_run_cost(1_000_000, 0) == pytest.approx(15.0)


def test_no_fetched_models_uses_fallback_rates() -> None:
    assert _compute_run_cost(1_000_000, 0) == pytest.approx(15.0)


@pytest.mark.asyncio
async def test_zero_tokens_cost_zero_even_on_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    await _start_run_with_chat(monkeypatch, "anthropic", "model-that-does-not-exist")
    assert _compute_run_cost(0, 0) == 0.0
