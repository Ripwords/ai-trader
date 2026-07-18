"""Tests for the router-level run-cost computation.

The invariant under test: a run with non-zero token usage must NEVER be
priced at $0.00 — an unknown model or a broken LLM_MODEL spec falls back
to conservative (env-overridable) rates instead of silently free-riding
under the daily cap.
"""

from __future__ import annotations

import pytest

from app.routers.agents import _compute_run_cost
from app.settings import get_settings


@pytest.fixture(autouse=True)
def _fresh_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_known_model_uses_pricing_table(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-sonnet-4-6")
    # 1M in @ $3 + 1M out @ $15
    assert _compute_run_cost(1_000_000, 1_000_000) == pytest.approx(18.0)


def test_unknown_model_uses_fallback_rates(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("LLM_MODEL", "anthropic/model-that-does-not-exist")
    monkeypatch.setenv("AGENTS_FALLBACK_INPUT_USD_PER_1M", "10.0")
    monkeypatch.setenv("AGENTS_FALLBACK_OUTPUT_USD_PER_1M", "20.0")
    get_settings.cache_clear()
    with caplog.at_level("WARNING", logger="app.routers.agents"):
        cost = _compute_run_cost(1_000_000, 500_000)
    assert cost == pytest.approx(10.0 + 10.0)
    assert "fallback" in caplog.text.lower()


def test_unparseable_model_spec_uses_fallback_rates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_MODEL", "no-provider-prefix")
    get_settings.cache_clear()
    cost = _compute_run_cost(1_000_000, 0)
    # Default conservative fallback: $15 per 1M input tokens.
    assert cost == pytest.approx(15.0)
    assert cost > 0.0


def test_zero_tokens_cost_zero_even_on_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LLM_MODEL", "anthropic/model-that-does-not-exist")
    get_settings.cache_clear()
    assert _compute_run_cost(0, 0) == 0.0
