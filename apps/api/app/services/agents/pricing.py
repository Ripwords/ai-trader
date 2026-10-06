from __future__ import annotations

# $ per 1M tokens. Update when providers change rates.
MODELS: dict[tuple[str, str], dict[str, float]] = {
    ("anthropic", "claude-sonnet-4-6"): {"input_per_1m": 3.00, "output_per_1m": 15.00},
    ("anthropic", "claude-opus-4-7"): {"input_per_1m": 15.00, "output_per_1m": 75.00},
    ("anthropic", "claude-haiku-4-5-20251001"): {"input_per_1m": 1.00, "output_per_1m": 5.00},
    ("openai", "gpt-4o"): {"input_per_1m": 2.50, "output_per_1m": 10.00},
    ("openai", "gpt-4o-mini"): {"input_per_1m": 0.15, "output_per_1m": 0.60},
    ("google", "gemini-2.5-pro"): {"input_per_1m": 1.25, "output_per_1m": 5.00},
    ("google", "gemini-2.5-flash"): {"input_per_1m": 0.075, "output_per_1m": 0.30},
    # DeepSeek bills off-peak hours at half these rates. One rate per model
    # fits here, so it is the peak cache-miss rate: a cost cap should overcount
    # rather than undercount. Read from
    # https://api-docs.deepseek.com/quick_start/pricing on 2026-10-06.
    ("deepseek", "deepseek-v4-pro"): {"input_per_1m": 1.32, "output_per_1m": 3.96},
    ("deepseek", "deepseek-flash"): {"input_per_1m": 0.30, "output_per_1m": 1.20},
    # Retired name, served and billed as deepseek-flash.
    ("deepseek", "deepseek-v4-flash"): {"input_per_1m": 0.30, "output_per_1m": 1.20},
    # Retired DeepSeek aliases (out of GET /models as of 2026-09-05, but they
    # still resolve). Kept so a run pinned to an old name is priced correctly
    # instead of silently costing $0. New runs should use the current ids above.
    ("deepseek", "deepseek-chat"): {"input_per_1m": 0.07, "output_per_1m": 0.28},
    ("deepseek", "deepseek-reasoner"): {"input_per_1m": 0.55, "output_per_1m": 2.20},
}


def price_run(
    provider: str,
    model_id: str,
    input_tokens: int,
    output_tokens: int,
) -> float | None:
    rates = MODELS.get((provider, model_id))
    if rates is None:
        return None
    return (
        rates["input_per_1m"] * input_tokens / 1_000_000
        + rates["output_per_1m"] * output_tokens / 1_000_000
    )
