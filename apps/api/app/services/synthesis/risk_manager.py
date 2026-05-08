# Ported from virattt/ai-hedge-fund src/agents/risk_manager.py.

from __future__ import annotations

import asyncio
import math

from app.schemas.synthesis import PortfolioSnapshot, RiskSizing, VolatilityBucket
from app.services.opend import OpendAdapter

_BARS_LOOKBACK = 60
_VOL_RETURNS_WINDOW = 30
_TRADING_DAYS = 252


def _annualized_volatility(closes: list[float]) -> float:
    if len(closes) < 2:
        return 0.0
    returns: list[float] = []
    for prev, curr in zip(closes[-(_VOL_RETURNS_WINDOW + 1) : -1], closes[-_VOL_RETURNS_WINDOW:]):
        if prev > 0 and curr > 0:
            returns.append(math.log(curr / prev))
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    return math.sqrt(variance) * math.sqrt(_TRADING_DAYS)


def _bucket_for(vol: float) -> tuple[VolatilityBucket, float]:
    if vol < 0.15:
        return "low", 25.0
    if vol < 0.30:
        return "medium", 20.0
    if vol < 0.50:
        return "high", 15.0
    return "very_high", 10.0


def _correlation_multiplier(portfolio: PortfolioSnapshot, symbol: str) -> float:
    others = [s for s, v in portfolio.positions.items() if s != symbol and v > 0]
    n = len(others)
    if n == 0:
        return 1.10
    if n <= 2:
        return 1.0
    return 0.85


async def compute_risk_sizing(
    symbol: str,
    portfolio: PortfolioSnapshot,
    opend: OpendAdapter,
) -> RiskSizing:
    kline = await asyncio.to_thread(
        lambda: opend.get_kline(code=symbol, ktype="1d", num=_BARS_LOOKBACK)
    )
    closes = [bar.close for bar in kline.bars]
    vol = _annualized_volatility(closes)
    bucket, max_pct = _bucket_for(vol)
    corr_mult = _correlation_multiplier(portfolio, symbol)

    max_position_usd = portfolio.total_value * (max_pct / 100.0) * corr_mult
    current = portfolio.positions.get(symbol, 0.0)
    remaining = max(0.0, max_position_usd - current)
    remaining = min(remaining, portfolio.cash)

    return RiskSizing(
        symbol=symbol,
        volatility_bucket=bucket,
        max_position_pct=max_pct,
        correlation_multiplier=corr_mult,
        max_position_usd=max_position_usd,
        remaining_position_usd=remaining,
    )


def compute_risk_sizing_from_closes(
    symbol: str,
    portfolio: PortfolioSnapshot,
    closes: list[float],
) -> RiskSizing:
    """Pure function used by tests + portfolio_manager when caller already
    has prices in hand (avoids re-fetching klines per symbol)."""
    vol = _annualized_volatility(closes)
    bucket, max_pct = _bucket_for(vol)
    corr_mult = _correlation_multiplier(portfolio, symbol)
    max_position_usd = portfolio.total_value * (max_pct / 100.0) * corr_mult
    current = portfolio.positions.get(symbol, 0.0)
    remaining = max(0.0, max_position_usd - current)
    remaining = min(remaining, portfolio.cash)
    return RiskSizing(
        symbol=symbol,
        volatility_bucket=bucket,
        max_position_pct=max_pct,
        correlation_multiplier=corr_mult,
        max_position_usd=max_position_usd,
        remaining_position_usd=remaining,
    )
