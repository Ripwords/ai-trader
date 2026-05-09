# Ported from virattt/ai-hedge-fund src/agents/portfolio_manager.py.

from __future__ import annotations

import asyncio
import math
import os

from app.schemas.synthesis import (
    Decision,
    DecideResponse,
    PortfolioSnapshot,
    RiskSizing,
    Signal,
)
from app.services.opend import OpendAdapter
from app.services.synthesis.risk_manager import compute_risk_sizing_from_closes

_NET_BUY_THRESHOLD = 30.0
_NET_SELL_THRESHOLD = -30.0
_BARS_LOOKBACK = 60


def _llm_enabled() -> bool:
    """No OpenAI/anthropic SDK in pyproject.toml — flag is the gate for when
    one is added. For now the deterministic fallback is the only path."""
    if os.getenv("SYNTHESIS_LLM_ENABLED", "").lower() not in {"1", "true", "yes"}:
        return False
    try:
        import openai  # type: ignore[import-not-found]  # noqa: F401

        return bool(os.getenv("OPENAI_API_KEY"))
    except ImportError:
        pass
    try:
        import anthropic  # type: ignore[import-not-found]  # noqa: F401

        return bool(os.getenv("ANTHROPIC_API_KEY"))
    except ImportError:
        return False


def _compact_signals(signals: list[Signal], symbol: str) -> list[dict[str, object]]:
    return [
        {"source": s.source, "sig": s.signal, "conf": s.confidence}
        for s in signals
        if s.symbol == symbol
    ]


def _net_score(compacted: list[dict[str, object]]) -> float:
    score = 0.0
    for entry in compacted:
        sig = entry["sig"]
        conf = float(entry["conf"])  # type: ignore[arg-type]
        if sig == "bullish":
            score += conf
        elif sig == "bearish":
            score -= conf
    return score / max(1, len(compacted))


def _directional_confidence(score: float) -> int:
    """For buy/sell — abs(net score) reflects how strongly the signals lean."""
    return max(0, min(100, int(round(abs(score)))))


def _hold_confidence(compacted: list[dict[str, object]], score: float) -> int:
    """For hold — average signal confidence, lightly discounted as the score
    approaches the action threshold (close calls are less confident holds).

    Without this distinction, four signals at 70% conf split 2 bull / 2 bear
    would produce a hold decision with confidence ~0 even though we're highly
    confident about the disagreement."""
    if not compacted:
        return 0
    avg_conf = sum(float(e["conf"]) for e in compacted) / len(compacted)
    threshold = _NET_BUY_THRESHOLD  # symmetric with sell threshold
    proximity = min(1.0, abs(score) / threshold)
    discount = 1.0 - 0.3 * proximity  # 1.0 when score=0, 0.7 when score at threshold
    return max(0, min(100, int(round(avg_conf * discount))))


def _fallback_decision(
    symbol: str,
    compacted: list[dict[str, object]],
    sizing: RiskSizing,
    current_price: float,
    current_position_usd: float,
) -> Decision:
    if not compacted or current_price <= 0:
        return Decision(
            symbol=symbol,
            action="hold",
            quantity=0,
            confidence=0,
            reasoning="no actionable signals",
        )
    score = _net_score(compacted)
    has_position = current_position_usd > 0
    has_cash = sizing.remaining_position_usd > 0

    if score > _NET_BUY_THRESHOLD and has_cash:
        qty = math.floor(sizing.remaining_position_usd / current_price)
        if qty <= 0:
            return Decision(
                symbol=symbol,
                action="hold",
                quantity=0,
                confidence=_hold_confidence(compacted, score),
                reasoning="bullish but remaining size < 1 share",
            )
        return Decision(
            symbol=symbol,
            action="buy",
            quantity=qty,
            confidence=_directional_confidence(score),
            reasoning=f"net bullish score {score:.0f} >= {int(_NET_BUY_THRESHOLD)}",
        )

    if score < _NET_SELL_THRESHOLD and has_position:
        qty = max(1, math.floor(current_position_usd / current_price))
        return Decision(
            symbol=symbol,
            action="sell",
            quantity=qty,
            confidence=_directional_confidence(score),
            reasoning=f"net bearish score {score:.0f} <= {int(_NET_SELL_THRESHOLD)}",
        )

    return Decision(
        symbol=symbol,
        action="hold",
        quantity=0,
        confidence=_hold_confidence(compacted, score),
        reasoning=f"net score {score:.0f} within hold band",
    )


async def _fetch_closes(opend: OpendAdapter, symbol: str) -> list[float]:
    kline = await asyncio.to_thread(
        lambda: opend.get_kline(code=symbol, ktype="1d", num=_BARS_LOOKBACK)
    )
    return [bar.close for bar in kline.bars]


async def decide(
    symbols: list[str],
    signals: list[Signal],
    portfolio: PortfolioSnapshot,
    opend: OpendAdapter,
) -> DecideResponse:
    decisions: list[Decision] = []
    for symbol in symbols:
        compacted = _compact_signals(signals, symbol)
        if not compacted:
            decisions.append(
                Decision(
                    symbol=symbol,
                    action="hold",
                    quantity=0,
                    confidence=0,
                    reasoning="no signals for symbol",
                )
            )
            continue

        closes = await _fetch_closes(opend, symbol)
        sizing = compute_risk_sizing_from_closes(symbol, portfolio, closes)
        current_price = closes[-1] if closes else 0.0
        current_position_usd = portfolio.positions.get(symbol, 0.0)

        if _llm_enabled():
            # Reserved for when an LLM SDK is added to pyproject.
            decisions.append(
                _fallback_decision(symbol, compacted, sizing, current_price, current_position_usd)
            )
        else:
            decisions.append(
                _fallback_decision(symbol, compacted, sizing, current_price, current_position_usd)
            )
    return DecideResponse(decisions=decisions)


def decide_from_prices(
    symbols: list[str],
    signals: list[Signal],
    portfolio: PortfolioSnapshot,
    closes_by_symbol: dict[str, list[float]],
) -> DecideResponse:
    """Pure-function variant for tests: caller supplies the close-price series
    so we don't need an OpendAdapter."""
    decisions: list[Decision] = []
    for symbol in symbols:
        compacted = _compact_signals(signals, symbol)
        if not compacted:
            decisions.append(
                Decision(
                    symbol=symbol,
                    action="hold",
                    quantity=0,
                    confidence=0,
                    reasoning="no signals for symbol",
                )
            )
            continue
        closes = closes_by_symbol.get(symbol, [])
        sizing = compute_risk_sizing_from_closes(symbol, portfolio, closes)
        current_price = closes[-1] if closes else 0.0
        current_position_usd = portfolio.positions.get(symbol, 0.0)
        decisions.append(
            _fallback_decision(symbol, compacted, sizing, current_price, current_position_usd)
        )
    return DecideResponse(decisions=decisions)
