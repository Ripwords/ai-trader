"""Confidence judge: one extra deep-model call after the Risk Manager decides.

TradingAgents never asks any role for a confidence number, so the decision
text has none to parse. The judge reads the debate and the final call and
states the probability that the call is right over the same horizon and
"right" definition the backtest scores against (see ``realized_return``).
"""

from __future__ import annotations

import logging
import re
from typing import Any, Protocol

logger = logging.getLogger(__name__)

HORIZON_DAYS = 7

_CORRECT_IF = {
    "strong-buy": "the stock beats SPY by more than 0.5 percentage points",
    "buy": "the stock beats SPY by more than 0.5 percentage points",
    "hold": "the stock finishes within 1 percentage point of SPY",
    "reduce": "the stock trails SPY by more than 0.5 percentage points",
    "sell": "the stock trails SPY by more than 0.5 percentage points",
}

_REPLY_LINE = re.compile(r"^\W*confidence\W*:\W*(\d{1,3})\s*%?\s*$", re.IGNORECASE | re.MULTILINE)


class _Llm(Protocol):
    async def ainvoke(self, input: str, config: Any = None) -> Any: ...


def build_judge_prompt(state: dict, rating: str, horizon_days: int = HORIZON_DAYS) -> str:
    inv = state.get("investment_debate_state") or {}
    risk = state.get("risk_debate_state") or {}
    sections = [
        ("Bull researcher", inv.get("bull_history")),
        ("Bear researcher", inv.get("bear_history")),
        ("Research manager", inv.get("judge_decision")),
        ("Trader plan", state.get("trader_investment_plan")),
        ("Aggressive risk analyst", risk.get("aggressive_history")),
        ("Conservative risk analyst", risk.get("conservative_history")),
        ("Neutral risk analyst", risk.get("neutral_history")),
        ("Final decision", state.get("final_trade_decision")),
    ]
    body = "\n\n".join(f"## {title}\n{text}" for title, text in sections if text)
    return (
        "You are auditing a trading committee's decision. You did not take part in it.\n"
        f"The committee's final rating is {rating.upper()}. Over the next {horizon_days} "
        f"trading days, that rating counts as correct if {_CORRECT_IF.get(rating, _CORRECT_IF['hold'])}.\n\n"
        "Estimate the probability, from 0 to 100, that the rating turns out correct. "
        "Weigh how strong the winning evidence is, how well the losing side was answered, "
        "and how much a week of noise could swamp the thesis. A coin-flip call is 50; "
        "do not drift toward 50 to sound cautious, and do not round to a multiple of 5 "
        "or 10 unless that is your actual estimate.\n\n"
        "Reply with exactly two lines and nothing else:\n"
        "CONFIDENCE: <integer 0-100>\n"
        "REASON: <one sentence>\n\n"
        f"{body}"
    )


def parse_judge_reply(text: str) -> int | None:
    matches = _REPLY_LINE.findall(text)
    if not matches:
        return None
    value = int(matches[-1])
    return value if 0 <= value <= 100 else None


async def judge_confidence(
    llm: _Llm, state: dict, rating: str, *, config: Any = None
) -> int | None:
    """The judge's probability for ``rating``, or ``None`` when the call fails
    or the reply has no well-formed ``CONFIDENCE:`` line."""
    try:
        reply = await llm.ainvoke(build_judge_prompt(state, rating), config=config)
    except Exception:  # noqa: BLE001 - a missing confidence must not fail the run
        logger.exception("confidence judge call failed")
        return None
    value = parse_judge_reply(reply.text)
    if value is None:
        logger.warning("confidence judge reply had no CONFIDENCE line: %.200s", reply.text)
    return value
