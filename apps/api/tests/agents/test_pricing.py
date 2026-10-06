import pytest

from app.services.agents.pricing import MODELS, price_run


def test_known_anthropic_model():
    cost = price_run(
        "anthropic", "claude-sonnet-4-6", input_tokens=1_000_000, output_tokens=200_000
    )
    assert cost > 0


def test_deepseek_models_priced_at_peak_list_rates():
    # 1M input + 1M output: flash at 0.30 / 1.20, v4-pro at 1.32 / 3.96.
    assert price_run("deepseek", "deepseek-flash", 1_000_000, 1_000_000) == pytest.approx(1.50)
    assert price_run("deepseek", "deepseek-v4-pro", 1_000_000, 1_000_000) == pytest.approx(5.28)
    # The retired v4-flash name is served and billed as deepseek-flash.
    assert price_run("deepseek", "deepseek-v4-flash", 1_000_000, 1_000_000) == pytest.approx(1.50)


def test_unknown_model_returns_none():
    assert price_run("anthropic", "claude-fake-99", input_tokens=100, output_tokens=100) is None


def test_models_table_shape():
    for (_provider, _model_id), prices in MODELS.items():
        assert "input_per_1m" in prices
        assert "output_per_1m" in prices
        assert prices["input_per_1m"] >= 0
        assert prices["output_per_1m"] >= 0


def test_zero_tokens_zero_cost():
    assert price_run("anthropic", "claude-sonnet-4-6", 0, 0) == 0.0
