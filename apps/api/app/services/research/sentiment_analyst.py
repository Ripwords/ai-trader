# Ported from virattt/ai-hedge-fund src/agents/sentiment.py
"""Insider-trade net flow + news sentiment ratio.

Pure function: takes lists of `InsiderTrade` and `NewsItem` and returns a
`Signal`. The router resolves them via the fundamentals service.

Weights: insider 0.3, news 0.7 (matches upstream).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from app.schemas.research import Signal, SignalType

if TYPE_CHECKING:
    from app.schemas.fundamentals import InsiderTrade, NewsItem


_INSIDER_WEIGHT = 0.3
_NEWS_WEIGHT = 0.7


def _insider_direction(trade: "InsiderTrade") -> str:
    """Buy => bullish, sell => bearish, else neutral.

    Prefer the explicit `transaction_type` field (yahoo-finance2 always
    sends positive shares regardless of direction). Fall back to a signed
    `transaction_shares`/`shares` field for older payloads where negative
    values denoted sells."""
    txn = (getattr(trade, "transaction_type", "") or "").lower()
    if "buy" in txn or "purchase" in txn:
        return "bullish"
    if "sell" in txn or "sale" in txn:
        return "bearish"
    shares = getattr(trade, "transaction_shares", None)
    if shares is None:
        shares = getattr(trade, "shares", None)
    if shares is not None:
        try:
            v = float(shares)
        except (TypeError, ValueError):
            v = 0.0
        if v > 0:
            return "bullish"
        if v < 0:
            return "bearish"
    return "neutral"


def _news_direction(item: "NewsItem") -> str:
    s = (getattr(item, "sentiment", "") or "").lower()
    if s in ("positive", "bullish"):
        return "bullish"
    if s in ("negative", "bearish"):
        return "bearish"
    return "neutral"


def _within_last_months(ts: "datetime | str | None", months: int) -> bool:
    if ts is None or ts == "":
        return True
    if isinstance(ts, str):
        try:
            # Yahoo data sends ISO date strings (YYYY-MM-DD or full ISO).
            ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return True
    cutoff = datetime.now(timezone.utc) - timedelta(days=30 * months)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts >= cutoff


def score_sentiment(
    symbol: str,
    insider_trades: "list[InsiderTrade]",
    news: "list[NewsItem]",
) -> Signal:
    insider_recent = [
        t
        for t in insider_trades
        if _within_last_months(getattr(t, "filing_date", None) or getattr(t, "date", None), 6)
    ]
    insider_dirs = [_insider_direction(t) for t in insider_recent]
    news_dirs = [_news_direction(n) for n in news]

    bull = (
        insider_dirs.count("bullish") * _INSIDER_WEIGHT
        + news_dirs.count("bullish") * _NEWS_WEIGHT
    )
    bear = (
        insider_dirs.count("bearish") * _INSIDER_WEIGHT
        + news_dirs.count("bearish") * _NEWS_WEIGHT
    )
    total = bull + bear

    if total == 0:
        return Signal(
            source="sentiment",
            symbol=symbol,
            signal="neutral",
            confidence=0,
            reasoning="no insider or news signals available",
            metadata={"insider_count": len(insider_dirs), "news_count": len(news_dirs)},
        )

    if bull > bear:
        signal: SignalType = "bullish"
    elif bear > bull:
        signal = "bearish"
    else:
        signal = "neutral"

    confidence = int(round(max(bull, bear) / total * 100))
    reasoning = (
        f"insider {insider_dirs.count('bullish')}+/{insider_dirs.count('bearish')}-"
        f" (last 6m, n={len(insider_dirs)}); "
        f"news {news_dirs.count('bullish')}+/{news_dirs.count('bearish')}- "
        f"(n={len(news_dirs)})"
    )
    return Signal(
        source="sentiment",
        symbol=symbol,
        signal=signal,
        confidence=confidence,
        reasoning=reasoning,
        metadata={
            "insider_bullish": insider_dirs.count("bullish"),
            "insider_bearish": insider_dirs.count("bearish"),
            "news_bullish": news_dirs.count("bullish"),
            "news_bearish": news_dirs.count("bearish"),
            "weighted_bull": round(bull, 3),
            "weighted_bear": round(bear, 3),
        },
    )
