# Ported from virattt/ai-hedge-fund src/agents/technicals.py
"""Trend / mean-reversion / momentum / volatility scoring on daily bars.

Pure function: takes the bar list and returns a `Signal`. The router fetches
bars from OpendAdapter.get_kline and passes them in.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pandas as pd

from app.schemas.research import Signal, SignalType

if TYPE_CHECKING:
    from app.schemas.quote import Bar


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _rsi(closes: pd.Series, period: int = 14) -> float | None:
    if len(closes) < period + 1:
        return None
    delta = closes.diff()
    gains = delta.clip(lower=0).rolling(period).mean()
    losses = (-delta.clip(upper=0)).rolling(period).mean()
    last_gain = gains.iloc[-1]
    last_loss = losses.iloc[-1]
    if pd.isna(last_gain) or pd.isna(last_loss):
        return None
    if last_loss == 0:
        return 100.0
    rs = last_gain / last_loss
    return float(100 - (100 / (1 + rs)))


def _atr(highs: pd.Series, lows: pd.Series, closes: pd.Series, period: int = 30) -> float | None:
    if len(closes) < period + 1:
        return None
    prev_close = closes.shift(1)
    tr = pd.concat(
        [highs - lows, (highs - prev_close).abs(), (lows - prev_close).abs()], axis=1
    ).max(axis=1)
    return float(tr.rolling(period).mean().iloc[-1])


def score_technicals(symbol: str, bars: "list[Bar]") -> Signal:
    if len(bars) < 60:
        return Signal(
            source="technicals",
            symbol=symbol,
            signal="neutral",
            confidence=0,
            reasoning=f"insufficient bars ({len(bars)} < 60)",
            metadata=None,
        )

    closes = pd.Series([b.close for b in bars], dtype="float64")
    highs = pd.Series([b.high for b in bars], dtype="float64")
    lows = pd.Series([b.low for b in bars], dtype="float64")

    ema8 = _ema(closes, 8).iloc[-1]
    ema21 = _ema(closes, 21).iloc[-1]
    ema55 = _ema(closes, 55).iloc[-1]

    if ema8 > ema21 > ema55:
        trend_score = 1
        trend_note = f"EMA8 {ema8:.2f} > EMA21 {ema21:.2f} > EMA55 {ema55:.2f}"
    elif ema8 < ema21 < ema55:
        trend_score = -1
        trend_note = f"EMA8 {ema8:.2f} < EMA21 {ema21:.2f} < EMA55 {ema55:.2f}"
    else:
        trend_score = 0
        trend_note = f"EMAs mixed ({ema8:.2f}/{ema21:.2f}/{ema55:.2f})"

    rsi = _rsi(closes, 14)
    if rsi is None:
        mr_score = 0
        mr_note = "RSI unavailable"
    elif rsi < 30:
        mr_score = 1
        mr_note = f"RSI {rsi:.1f} < 30 (oversold)"
    elif rsi > 70:
        mr_score = -1
        mr_note = f"RSI {rsi:.1f} > 70 (overbought)"
    else:
        mr_score = 0
        mr_note = f"RSI {rsi:.1f} mid-range"

    if len(closes) >= 63:
        ret_3m = float(closes.iloc[-1] / closes.iloc[-63] - 1.0)
    else:
        ret_3m = float(closes.iloc[-1] / closes.iloc[0] - 1.0)
    if ret_3m > 0.10:
        mom_score = 1
    elif ret_3m < -0.10:
        mom_score = -1
    else:
        mom_score = 0
    mom_note = f"3m return {ret_3m:+.1%}"

    atr = _atr(highs, lows, closes, 30)
    last_price = float(closes.iloc[-1])
    atr_pct = (atr / last_price) if (atr is not None and last_price > 0) else None

    raw = (trend_score + mr_score + mom_score) / 3.0
    # Upstream uses +/-0.2 cutoffs after weighting. With three equally-weighted
    # legs each in {-1,0,+1}, the smallest non-zero raw is ~0.333; a single
    # leg agreeing with the others is enough to flip out of neutral.
    if raw > 0.2:
        signal: SignalType = "bullish"
    elif raw < -0.2:
        signal = "bearish"
    else:
        signal = "neutral"

    base_confidence = abs(raw) * 100
    if atr_pct is not None:
        # High vol (>5% daily ATR) damps confidence; low vol boosts it slightly.
        vol_factor = max(0.5, min(1.2, 1.0 - (atr_pct - 0.02) * 5))
        base_confidence *= vol_factor
    confidence = max(0, min(100, int(round(base_confidence))))

    reasoning = "; ".join(
        [trend_note, mr_note, mom_note] + ([f"ATR {atr_pct:.2%}"] if atr_pct is not None else [])
    )
    return Signal(
        source="technicals",
        symbol=symbol,
        signal=signal,
        confidence=confidence,
        reasoning=reasoning,
        metadata={
            "trend": trend_score,
            "mean_reversion": mr_score,
            "momentum": mom_score,
            "rsi": None if rsi is None else round(rsi, 2),
            "ret_3m": round(ret_3m, 4),
            "atr_pct": None if atr_pct is None else round(atr_pct, 4),
            "ema8": round(float(ema8), 4),
            "ema21": round(float(ema21), 4),
            "ema55": round(float(ema55), 4),
        },
    )


__all__ = ["score_technicals", "_rsi", "_atr", "_ema"]
