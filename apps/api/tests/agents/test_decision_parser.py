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


# ---- Confidence: real number or None (never a fabricated default) -------


def test_confidence_is_none_when_no_number_present() -> None:
    """The model is not prompted for a confidence number, so when it doesn't
    volunteer one we must NOT invent a fake default — return None so the UI
    can show a qualitative band instead of a misleading percentage."""
    out = _decision_for("BUY")
    assert out["confidence"] is None


def test_confidence_parses_numeric_when_present() -> None:
    out = _decision_for("BUY with confidence: 85")
    assert out["confidence"] == 85


def test_confidence_parses_with_pct_sign() -> None:
    out = _decision_for("BUY (confidence 72%)")
    assert out["confidence"] == 72


def test_confidence_parses_conviction_phrasing() -> None:
    out = _decision_for("HOLD with conviction of 60%")
    assert out["confidence"] == 60


def test_confidence_parses_percent_before_keyword() -> None:
    out = _decision_for("SELL — 80% conviction in the bear case")
    assert out["confidence"] == 80


def test_confidence_clamps_to_0_100() -> None:
    out_low = _decision_for("BUY confidence: -5")
    out_high = _decision_for("BUY confidence: 200")
    # negative gets clamped (sign discarded by the unsigned regex), 200 clamped to 100
    assert 0 <= out_low["confidence"] <= 100
    assert out_high["confidence"] == 100


# ---- Rationale: full text, never truncated ------------------------------


def test_rationale_is_not_truncated() -> None:
    """The rationale is the full risk-manager report — the UI renders it as a
    structured section, so we must not clip it (the DB column is unlimited
    ``text``)."""
    text = "BUY " + ("x" * 1000)
    out = _decision_for(text)
    assert out["rationale"] == text


# ---- Rating: explicit verdict wins over incidental body mentions --------


def test_canonical_final_marker_beats_body_sell_mentions() -> None:
    """The headline bug: a HOLD writeup whose body merely *discusses* selling
    was misread as SELL because the regex matched the first ``sell`` anywhere.
    The canonical FINAL TRANSACTION PROPOSAL marker must win."""
    text = (
        "Final Recommendation: HOLD\n\n"
        "The aggressive analyst argues insider selling is pre-planned and we "
        "should buy aggressively into the dip. The conservative analyst would "
        "rather sell into strength than hold a falling knife.\n\n"
        "On balance the risks cancel out.\n\n"
        "FINAL TRANSACTION PROPOSAL: **HOLD**"
    )
    assert _decision_for(text)["rating"] == "hold"


def test_recommendation_header_beats_body_when_no_canonical_marker() -> None:
    """Even without the canonical marker, an explicit ``Final Recommendation:``
    header is authoritative over incidental buy/sell mentions in the body."""
    text = (
        "Final Recommendation: HOLD\n\n"
        "Bulls want to buy; bears want to sell. We stay neutral."
    )
    assert _decision_for(text)["rating"] == "hold"


def test_canonical_buy_marker_beats_body_hold_mentions() -> None:
    text = (
        "We considered whether to hold, but the setup is compelling.\n"
        "FINAL TRANSACTION PROPOSAL: **BUY**"
    )
    assert _decision_for(text)["rating"] == "buy"


# ---- DB compatibility (NOT NULL) --------------------------------------------------


@pytest.mark.asyncio
async def test_agent_decisions_insert_succeeds_with_default_confidence(
    pg_pool,
) -> None:
    """``agent_decisions.confidence`` is ``NOT NULL``. The parser now returns
    ``None`` when the model gives no number, so the persistence boundary (the
    web tee writer) supplies the neutral 50 default; this test mirrors that
    coercion to prove the NOT NULL path still holds."""
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
        # No confidence number in the text -> parser returns None; the tee
        # writer coerces to the neutral 50 to satisfy NOT NULL.
        confidence = out["confidence"] if out["confidence"] is not None else 50
        await conn.execute(
            "INSERT INTO agent_decisions"
            "(run_id, user_id, symbol, trade_date, rating, confidence, rationale) "
            "VALUES($1, $2, 'NVDA', current_date, $3, $4, $5)",
            run_id,
            user_id,
            out["rating"],
            confidence,
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
