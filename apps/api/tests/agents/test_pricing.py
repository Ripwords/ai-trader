from app.services.agents.pricing import MODELS, price_run


def test_known_anthropic_model():
    cost = price_run(
        "anthropic", "claude-sonnet-4-6", input_tokens=1_000_000, output_tokens=200_000
    )
    assert cost > 0


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
