# Ported from virattt/ai-hedge-fund src/agents/valuation.py
"""Four-method weighted intrinsic-value blend.

Methods: DCF (35%), Owner Earnings (35%), EV/EBITDA (20%), Residual Income (10%).
Each method estimates intrinsic equity value; we compute the weighted percentage
gap vs market cap and emit bullish/bearish/neutral.

Pure function — takes a `FinancialMetrics`, returns a `Signal`. No I/O.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.schemas.research import Signal, SignalType

if TYPE_CHECKING:
    from app.schemas.fundamentals import FinancialMetrics


_DCF_GROWTH = 0.05
_DCF_DISCOUNT = 0.10
_DCF_TERMINAL_MULTIPLE = 15
_DCF_YEARS = 5

_OE_MULTIPLE = 15

_EV_EBITDA_MULTIPLE = 12

_RI_YEARS = 5
_RI_COST_OF_EQUITY = 0.10

_WEIGHTS = {"dcf": 0.35, "owner_earnings": 0.35, "ev_ebitda": 0.20, "residual_income": 0.10}


def _dcf_value(fcf: float | None) -> float | None:
    if fcf is None or fcf <= 0:
        return None
    pv = 0.0
    cash = fcf
    for year in range(1, _DCF_YEARS + 1):
        cash = cash * (1 + _DCF_GROWTH)
        pv += cash / ((1 + _DCF_DISCOUNT) ** year)
    terminal = (cash * _DCF_TERMINAL_MULTIPLE) / ((1 + _DCF_DISCOUNT) ** _DCF_YEARS)
    return pv + terminal


def _owner_earnings_value(
    net_income: float | None, fcf: float | None, capex: float | None, da: float | None
) -> float | None:
    """Buffett owner earnings: net_income + D&A - capex. Falls back to FCF if
    components unavailable. Multiplied by 15x."""
    owner: float | None = None
    if net_income is not None and capex is not None and da is not None:
        owner = net_income + da - abs(capex)
    elif fcf is not None:
        owner = fcf
    if owner is None or owner <= 0:
        return None
    return owner * _OE_MULTIPLE


def _ev_ebitda_value(
    ebitda: float | None,
    operating_income: float | None,
    revenue: float | None,
    operating_margin: float | None,
    total_debt: float | None,
    cash: float | None,
) -> float | None:
    """Apply industry-median 12x to EBITDA, subtract net debt to get equity."""
    eb: float | None = ebitda
    if eb is None and operating_income is not None:
        eb = operating_income
    if eb is None and revenue is not None and operating_margin is not None:
        eb = revenue * operating_margin
    if eb is None or eb <= 0:
        return None
    enterprise_value = eb * _EV_EBITDA_MULTIPLE
    net_debt = (total_debt or 0.0) - (cash or 0.0)
    return enterprise_value - net_debt


def _residual_income_value(
    book_value: float | None, roe: float | None
) -> float | None:
    """Edwards-Bell-Ohlson lite: equity * (ROE - cost_of_equity), discounted
    over 5 years and added to current book value."""
    if book_value is None or roe is None or book_value <= 0:
        return None
    excess = roe - _RI_COST_OF_EQUITY
    pv = 0.0
    equity = book_value
    for year in range(1, _RI_YEARS + 1):
        ri = equity * excess
        pv += ri / ((1 + _RI_COST_OF_EQUITY) ** year)
        equity = equity * (1 + excess)
    return book_value + pv


def score_valuation(symbol: str, metrics: "FinancialMetrics") -> Signal:
    market_cap = getattr(metrics, "market_cap", None)
    fcf = getattr(metrics, "free_cash_flow", None)
    net_income = getattr(metrics, "net_income", None)
    capex = getattr(metrics, "capex", None)
    da = getattr(metrics, "depreciation_amortization", None)
    ebitda = getattr(metrics, "ebitda", None)
    operating_income = getattr(metrics, "operating_income", None)
    revenue = getattr(metrics, "revenue", None)
    operating_margin = getattr(metrics, "operating_margin", None)
    total_debt = getattr(metrics, "total_debt", None)
    cash = getattr(metrics, "cash", None)
    book_value = getattr(metrics, "book_value", None)
    roe = getattr(metrics, "return_on_equity", None)

    if market_cap is None or market_cap <= 0:
        return Signal(
            source="valuation",
            symbol=symbol,
            signal="neutral",
            confidence=0,
            reasoning="market cap unavailable",
            metadata=None,
        )

    estimates: dict[str, float] = {}
    dcf = _dcf_value(fcf)
    if dcf is not None:
        estimates["dcf"] = dcf
    oe = _owner_earnings_value(net_income, fcf, capex, da)
    if oe is not None:
        estimates["owner_earnings"] = oe
    ev = _ev_ebitda_value(ebitda, operating_income, revenue, operating_margin, total_debt, cash)
    if ev is not None and ev > 0:
        estimates["ev_ebitda"] = ev
    ri = _residual_income_value(book_value, roe)
    if ri is not None and ri > 0:
        estimates["residual_income"] = ri

    if not estimates:
        return Signal(
            source="valuation",
            symbol=symbol,
            signal="neutral",
            confidence=0,
            reasoning="no valuation method produced an estimate",
            metadata=None,
        )

    total_weight = sum(_WEIGHTS[k] for k in estimates)
    weighted_gap = sum(
        _WEIGHTS[k] * (estimates[k] / market_cap - 1.0) for k in estimates
    ) / total_weight

    if weighted_gap > 0.15:
        signal: SignalType = "bullish"
    elif weighted_gap < -0.15:
        signal = "bearish"
    else:
        signal = "neutral"
    confidence = min(100, int(round(abs(weighted_gap) * 100 * 5)))

    reasoning_bits = [f"{k}={v / market_cap:.2f}x mcap" for k, v in estimates.items()]
    reasoning = (
        f"weighted gap {weighted_gap:+.1%} vs mcap "
        f"({len(estimates)} methods: {', '.join(reasoning_bits)})"
    )
    return Signal(
        source="valuation",
        symbol=symbol,
        signal=signal,
        confidence=confidence,
        reasoning=reasoning,
        metadata={
            "weighted_gap": round(weighted_gap, 4),
            "estimates": {k: round(v, 2) for k, v in estimates.items()},
            "market_cap": market_cap,
        },
    )
