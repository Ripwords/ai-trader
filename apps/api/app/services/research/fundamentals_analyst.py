# Ported from virattt/ai-hedge-fund src/agents/fundamentals.py
"""Threshold-based scoring over financial metrics.

Pure function: takes a `FinancialMetrics` and returns a `Signal`. No I/O.
The router resolves the metrics via the fundamentals service and hands them in.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.schemas.research import Signal, SignalType

if TYPE_CHECKING:
    from app.schemas.fundamentals import FinancialMetrics


def _check(value: float | None, threshold: float, *, greater: bool) -> int | None:
    if value is None:
        return None
    return 1 if (value > threshold if greater else value < threshold) else 0


def score_fundamentals(symbol: str, metrics: "FinancialMetrics") -> Signal:
    roe = getattr(metrics, "return_on_equity", None)
    profit_margin = getattr(metrics, "profit_margin", None)
    revenue_growth = getattr(metrics, "revenue_growth", None)
    debt_to_equity = getattr(metrics, "debt_to_equity", None)
    current_ratio = getattr(metrics, "current_ratio", None)

    bull = 0
    bear = 0
    counted = 0
    notes: list[str] = []

    roe_hit = _check(roe, 0.15, greater=True)
    if roe_hit is not None:
        counted += 1
        if roe_hit:
            bull += 1
            notes.append(f"ROE {roe:.1%} > 15%")
        else:
            notes.append(f"ROE {roe:.1%} <= 15%")

    pm_hit = _check(profit_margin, 0.20, greater=True)
    if pm_hit is not None:
        counted += 1
        if pm_hit:
            bull += 1
            notes.append(f"profit margin {profit_margin:.1%} > 20%")
        else:
            notes.append(f"profit margin {profit_margin:.1%} <= 20%")

    rg_hit = _check(revenue_growth, 0.10, greater=True)
    if rg_hit is not None:
        counted += 1
        if rg_hit:
            bull += 1
            notes.append(f"revenue growth {revenue_growth:.1%} > 10%")
        else:
            notes.append(f"revenue growth {revenue_growth:.1%} <= 10%")

    if debt_to_equity is not None:
        counted += 1
        if debt_to_equity < 0.5:
            bull += 1
            notes.append(f"D/E {debt_to_equity:.2f} < 0.5")
        elif debt_to_equity > 2.0:
            bear += 1
            notes.append(f"D/E {debt_to_equity:.2f} > 2.0")
        else:
            notes.append(f"D/E {debt_to_equity:.2f} mid-range")

    cr_hit = _check(current_ratio, 1.5, greater=True)
    if cr_hit is not None:
        counted += 1
        if cr_hit:
            bull += 1
            notes.append(f"current ratio {current_ratio:.2f} > 1.5")
        else:
            notes.append(f"current ratio {current_ratio:.2f} <= 1.5")

    net = bull - bear
    if counted == 0:
        signal: SignalType = "neutral"
        confidence = 0
    elif net >= 2:
        signal = "bullish"
        confidence = min(100, int(round(net / counted * 100)))
    elif net <= -1 and bear >= 1:
        signal = "bearish"
        confidence = min(100, int(round(abs(net) / counted * 100)))
    else:
        signal = "neutral"
        confidence = max(20, 50 - abs(net) * 10)

    reasoning = "; ".join(notes) if notes else "no metrics available"
    return Signal(
        source="fundamentals",
        symbol=symbol,
        signal=signal,
        confidence=confidence,
        reasoning=reasoning,
        metadata={"bullish_count": bull, "bearish_count": bear, "counted": counted},
    )
