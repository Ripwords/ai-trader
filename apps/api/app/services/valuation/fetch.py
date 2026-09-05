from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.services.agents.toolkit import _internal_get
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput


def _dec(v) -> Decimal | None:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def avg_close_by_year(daily_bars: list[dict]) -> dict[str, Decimal]:
    sums: dict[str, Decimal] = {}
    counts: dict[str, int] = {}
    for b in daily_bars:
        t = b.get("time") or b.get("date")
        close = _dec(b.get("close"))
        if not t or close is None:
            continue
        year = str(t)[:4]
        sums[year] = sums.get(year, Decimal("0")) + close
        counts[year] = counts.get(year, 0) + 1
    return {y: (sums[y] / counts[y]) for y in sums}


def _history(rows: list[dict]) -> list[HistoryPeriod]:
    return [
        HistoryPeriod(
            period=str(r.get("period") or ""),
            revenue=_dec(r.get("revenue")),
            net_income=_dec(r.get("net_income")),
            fcf=_dec(r.get("fcf")),
            total_debt=_dec(r.get("total_debt")),
            cash=_dec(r.get("cash")),
            shareholders_equity=_dec(r.get("shareholders_equity")),
        )
        for r in rows
    ]


def _metrics(m: dict) -> Metrics:
    return Metrics(
        market_cap=_dec(m.get("market_cap")),
        pe_ratio=_dec(m.get("pe_ratio")),
        pb_ratio=_dec(m.get("pb_ratio")),
        ps_ratio=_dec(m.get("ps_ratio")),
        eps=_dec(m.get("eps")),
        free_cash_flow=_dec(m.get("free_cash_flow")),
        shares_outstanding=_dec(m.get("shares_outstanding")),
        beta=_dec(m.get("beta")),
    )


def to_valuation_input(symbol: str, payload: dict) -> ValuationInput:
    metrics = _metrics(payload.get("metrics") or {})
    history = _history(payload.get("history") or [])
    bars = payload.get("dailyBars") or []
    newest_close = _dec(bars[-1].get("close")) if bars else None
    current_price = newest_close if newest_close is not None else Decimal("0")

    fcf_base = metrics.free_cash_flow
    if fcf_base is None and history and history[0].fcf is not None:
        fcf_base = history[0].fcf

    # Net debt is debt less cash; a cash-rich balance sheet is net cash and
    # adds to equity value. Missing figures count as zero, never as debt.
    latest = history[0] if history else None
    total_debt = (latest.total_debt if latest else None) or Decimal("0")
    cash = (latest.cash if latest else None) or Decimal("0")
    net_debt = total_debt - cash

    shares = metrics.shares_outstanding

    avg_price_by_period = avg_close_by_year(bars) if bars else None

    # The web side converts the quote into the statements' currency when the
    # two differ (and says so); every per-share figure here is in that unit.
    raw_metrics = payload.get("metrics") or {}
    conversion = payload.get("price_conversion")
    currency = (
        conversion.get("to") if isinstance(conversion, dict) else None
    ) or raw_metrics.get("financial_currency") or raw_metrics.get("currency")
    price_note: str | None = None
    if isinstance(conversion, dict):
        price_note = (
            f"quote converted from {conversion.get('from')} to {conversion.get('to')} "
            f"at {conversion.get('rate')} so prices and fair value share the statements' currency"
        )
    elif payload.get("price_conversion_error"):
        price_note = f"{payload['price_conversion_error']}; fair value and price are in different currencies"

    return ValuationInput(
        symbol=symbol,
        current_price=current_price,
        fcf_base=fcf_base,
        net_debt=net_debt,
        shares_outstanding=shares,
        beta=metrics.beta,
        history=history,
        metrics=metrics,
        avg_price_by_period=avg_price_by_period or None,
        currency=str(currency) if currency else None,
        price_note=price_note,
    )


async def fetch_valuation_input(symbol: str) -> ValuationInput:
    payload = await _internal_get("/api/internal/yahoo/valuation-inputs", {"symbol": symbol})
    return to_valuation_input(symbol, payload)
