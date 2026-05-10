"""Tests for ``_extract_decision`` — the AgentState → decision-event parser.

The parser maps the trader's free-text ``final_trade_decision`` field to the
five wire-supported ratings (``strong-buy``, ``buy``, ``hold``, ``reduce``,
``sell``) and a confidence integer. The tee writer inserts those values into
``agent_decisions`` whose ``confidence`` is ``NOT NULL`` — so the parser must
default confidence to a sane integer (50) rather than ``None`` when a number
isn't extractable.
"""

from __future__ import annotations

import pytest

from app.services.agents.graph import _extract_decision


def _decision_for(text: str) -> dict:
    """Run ``_extract_decision`` against a state-snapshot pair containing ``text``."""
    out = _extract_decision({}, {"final_trade_decision": text})
    assert out is not None, f"parser returned None for {text!r}"
    return out


def test_returns_none_when_unchanged() -> None:
    assert _extract_decision(
        {"final_trade_decision": "BUY NVDA"},
        {"final_trade_decision": "BUY NVDA"},
    ) is None


def test_returns_none_when_empty() -> None:
    assert _extract_decision({}, {"final_trade_decision": ""}) is None


# ---- Rating extraction --------------------------------------------------


def test_plain_buy() -> None:
    assert _decision_for("Recommendation: BUY")["rating"] == "buy"


def test_plain_sell() -> None:
    assert _decision_for("Recommendation: SELL")["rating"] == "sell"


def test_hold_default() -> None:
    assert _decision_for("Final: HOLD position")["rating"] == "hold"


def test_strong_buy_with_hyphen_beats_plain_buy() -> None:
    """STRONG-BUY should not be mangled into ``buy``."""
    assert _decision_for("Final rating: STRONG-BUY (high conviction)")["rating"] == "strong-buy"


def test_strong_buy_with_space() -> None:
    assert _decision_for("STRONG BUY recommendation")["rating"] == "strong-buy"


def test_strong_buy_no_separator() -> None:
    assert _decision_for("STRONGBUY")["rating"] == "strong-buy"


def test_strong_buy_lowercase() -> None:
    assert _decision_for("conclusion: strong buy")["rating"] == "strong-buy"


def test_strong_sell_with_hyphen_does_not_get_mangled_to_sell() -> None:
    out = _decision_for("Verdict: STRONG-SELL (capital preservation)")
    # We don't have a strong-sell wire rating; map to sell BUT not to a
    # strong-buy and not to hold.
    assert out["rating"] == "sell"


def test_strong_sell_with_space() -> None:
    assert _decision_for("STRONG SELL on weak fundamentals")["rating"] == "sell"


def test_reduce_explicit() -> None:
    assert _decision_for("Recommendation: REDUCE exposure")["rating"] == "reduce"


def test_reduce_lowercase() -> None:
    assert _decision_for("we reduce our position")["rating"] == "reduce"


def test_reduce_does_not_get_clobbered_by_buy_in_other_words() -> None:
    """Be careful with substring matches — ``reduce`` mentions of ``buyer`` must not turn into ``buy``."""
    out = _decision_for("Recommendation: REDUCE — buyers should be cautious")
    assert out["rating"] == "reduce"


# ---- Confidence default --------------------------------------------------


def test_confidence_defaults_to_50_when_absent() -> None:
    out = _decision_for("BUY")
    assert out["confidence"] == 50
    assert isinstance(out["confidence"], int)


def test_confidence_parses_numeric_when_present() -> None:
    out = _decision_for("BUY with confidence: 85")
    assert out["confidence"] == 85


def test_confidence_parses_with_pct_sign() -> None:
    out = _decision_for("BUY (confidence 72%)")
    assert out["confidence"] == 72


def test_confidence_clamps_to_0_100() -> None:
    out_low = _decision_for("BUY confidence: -5")
    out_high = _decision_for("BUY confidence: 200")
    # negative gets clamped (sign discarded by the unsigned regex), 200 clamped to 100
    assert 0 <= out_low["confidence"] <= 100
    assert out_high["confidence"] == 100


# ---- Rationale --------------------------------------------------


def test_rationale_truncates_to_500_chars() -> None:
    text = "BUY " + ("x" * 1000)
    out = _decision_for(text)
    assert len(out["rationale"]) == 500


# ---- DB compatibility (NOT NULL) --------------------------------------------------


@pytest.mark.asyncio
async def test_agent_decisions_insert_succeeds_with_default_confidence(
    pg_pool,
) -> None:
    """The default confidence (int 50) must satisfy the NOT NULL constraint."""
    user_id = "00000000-0000-0000-0000-000000000099"
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO users(id, name) VALUES($1, 'parser-default') "
            "ON CONFLICT DO NOTHING",
            user_id,
        )
        run_id = await conn.fetchval(
            "INSERT INTO agent_runs(user_id, symbol, trade_date, config, status) "
            "VALUES($1, 'NVDA', current_date, '{}'::jsonb, 'running') "
            "RETURNING id",
            user_id,
        )
        out = _decision_for("Recommendation: REDUCE exposure")
        await conn.execute(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale) "
            "VALUES($1, $2, 'NVDA', current_date, $3, $4, $5)",
            run_id,
            user_id,
            out["rating"],
            out["confidence"],
            out["rationale"],
        )
        row = await conn.fetchrow(
            "SELECT rating, confidence FROM agent_decisions WHERE run_id = $1",
            run_id,
        )
    assert row is not None
    assert row["rating"] == "reduce"
    assert row["confidence"] == 50


def test_signal_processor_picks_up_final_marker_when_regex_misses() -> None:
    """Risk Manager sometimes emits the formal ``FINAL TRANSACTION PROPOSAL:
    BUY`` marker without using the bare verb anywhere else; our regex
    misses that, but TradingAgents' deterministic extractor catches it."""
    text = (
        "Based on the analysis, I am positioning the portfolio long the name. "
        "Risks are manageable.\n\n**FINAL TRANSACTION PROPOSAL: BUY**"
    )
    out = _decision_for(text)
    assert out["rating"] == "buy"


def test_strong_buy_still_wins_over_signal_processor_buy() -> None:
    """When our regex finds ``strong-buy``, that's MORE specific than the
    SignalProcessor's BUY/SELL/HOLD-only output — keep our finer signal."""
    text = (
        "After weighing all evidence I land on a STRONG BUY.\n"
        "FINAL TRANSACTION PROPOSAL: BUY"
    )
    out = _decision_for(text)
    assert out["rating"] == "strong-buy"
