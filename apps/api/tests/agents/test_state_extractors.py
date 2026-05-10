"""Tests for the new state-diff extractors that surface TradingAgents'
full output (analyst reports, three-way risk debate, synthesis artifacts).

Earlier the translator only emitted node-end ``summary`` truncations and
the bull/bear debate; the bulk of TradingAgents' output (full per-analyst
reports, the Research Manager's investment plan, the Trader's expanded
plan, the three-way risk debate between aggressive/conservative/neutral
analysts) never reached the UI. These extractors close that gap by
diffing AgentState snapshots and emitting one event per artifact.
"""

from __future__ import annotations

from app.services.agents.graph import (
    _extract_reports,
    _extract_risk_debate,
    _extract_synthesis,
)


def test_extract_reports_returns_one_per_changed_analyst() -> None:
    prev = {"market_report": "", "fundamentals_report": "old"}
    curr = {
        "market_report": "## Market\nBullish technicals.",
        "sentiment_report": "Sentiment positive.",
        "fundamentals_report": "old",  # unchanged
    }
    out = _extract_reports(prev, curr)
    kinds = {r["kind"] for r in out}
    assert kinds == {"market", "sentiment"}
    market = next(r for r in out if r["kind"] == "market")
    assert market["node"] == "Market Analyst"
    assert "Bullish technicals" in market["content"]


def test_extract_reports_skips_when_unchanged() -> None:
    prev = {"market_report": "same"}
    curr = {"market_report": "same"}
    assert _extract_reports(prev, curr) == []


def test_extract_synthesis_surfaces_investment_and_trader_plans() -> None:
    prev: dict = {}
    curr = {
        "investment_plan": "## Plan\nGo long.",
        "trader_investment_plan": "Buy 100 shares at limit 12.50.",
    }
    out = _extract_synthesis(prev, curr)
    stages = {s["stage"] for s in out}
    assert stages == {"investment-plan", "trader-plan"}


def test_extract_synthesis_surfaces_judge_decision_from_research_manager() -> None:
    """The Research Manager's verdict on the bull/bear debate (the
    ``investment_debate_state.judge_decision`` field) is its own
    closing-argument artifact, distinct from the synthesised
    ``investment_plan`` that follows."""
    prev = {"investment_debate_state": {"judge_decision": ""}}
    curr = {"investment_debate_state": {"judge_decision": "Bull side wins."}}
    out = _extract_synthesis(prev, curr)
    assert len(out) == 1
    assert out[0]["stage"] == "judge-decision"
    assert out[0]["node"] == "Research Manager"


def test_extract_risk_debate_identifies_speaker_from_response_diff() -> None:
    prev = {
        "risk_debate_state": {
            "count": 0,
            "current_aggressive_response": "",
            "current_conservative_response": "",
            "current_neutral_response": "",
        }
    }
    curr = {
        "risk_debate_state": {
            "count": 1,
            "current_aggressive_response": "Press the bet.",
            "current_conservative_response": "",
            "current_neutral_response": "",
        }
    }
    out = _extract_risk_debate(prev, curr)
    assert out is not None
    assert out["speaker"] == "aggressive"
    assert out["text"] == "Press the bet."
    assert out["turn"] == 1


def test_extract_risk_debate_falls_back_to_latest_speaker_label() -> None:
    """When response-field diffs are ambiguous (TradingAgents sometimes
    overwrites the same field across speakers), trust ``latest_speaker``."""
    prev = {"risk_debate_state": {"count": 0, "latest_speaker": "Risky Analyst"}}
    curr = {
        "risk_debate_state": {
            "count": 1,
            "latest_speaker": "Conservative Analyst",
            # No response-field diff because both prev and curr are blank.
        }
    }
    out = _extract_risk_debate(prev, curr)
    assert out is not None
    assert out["speaker"] == "conservative"


def test_extract_risk_debate_skips_when_count_unchanged() -> None:
    state = {"risk_debate_state": {"count": 3}}
    assert _extract_risk_debate(state, state) is None
