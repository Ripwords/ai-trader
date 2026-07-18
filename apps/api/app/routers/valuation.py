from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.deps import get_opend, require_internal_bearer
from app.services.opend import OpendAdapter
from app.services.valuation.compose import value
from app.services.valuation.fetch import fetch_valuation_input
from app.services.valuation.models import ValuationResult, Veto
from app.services.valuation.persist import record_valuation_snapshot

router = APIRouter(tags=["valuation"])

# Screener bounds: a watchlist sweep fans out to Yahoo via the web internal
# route per symbol, so keep both the per-request symbol count and the
# in-flight concurrency small.
_SCREEN_MAX_SYMBOLS = 25
_SCREEN_CONCURRENCY = 3


class ScreenRow(BaseModel):
    symbol: str
    fair_value: Decimal | None = None
    current_price: Decimal | None = None
    margin_of_safety_pct: Decimal | None = None
    data_quality: Literal["full", "multiples_only", "unavailable"] | None = None
    veto: bool | None = None
    error: str | None = None


class ScreenResponse(BaseModel):
    rows: list[ScreenRow]
    total_symbols: int
    truncated: bool = False
    source: Literal["watchlist", "symbols"]
    warnings: list[str] = []


@router.get("/valuation", response_model=ValuationResult)
async def get_valuation(symbol: str = Query(..., min_length=1)) -> ValuationResult:
    try:
        vi = await fetch_valuation_input(symbol)
    except Exception:  # noqa: BLE001 - data-source outage degrades, never 500s
        return ValuationResult(
            symbol=symbol,
            current_price=Decimal("0"),
            fair_value=None,
            margin_of_safety_pct=None,
            scenarios=[],
            assumptions_used=None,
            multiples=None,
            historical_multiples=None,
            reverse_dcf_implied_growth=None,
            data_quality="unavailable",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=["valuation inputs unavailable"],
        )
    result = value(vi)
    # Best-effort persistence — record_valuation_snapshot never raises.
    # Degraded 'unavailable' results (above) are deliberately not persisted:
    # a current_price=0 placeholder row would only pollute the reflection
    # loop's closest-snapshot lookup.
    await record_valuation_snapshot(result, source="chat")
    return result


def _screen_sort_key(row: ScreenRow) -> tuple[bool, Decimal]:
    """Margin of safety descending, nulls (incl. error rows) last."""
    mos = row.margin_of_safety_pct
    return (mos is None, -(mos if mos is not None else Decimal("0")))


async def _screen_one(sem: asyncio.Semaphore, symbol: str) -> ScreenRow:
    """Value one symbol through the same path as /valuation, fail-soft.

    Reuses fetch+value and persists a snapshot (source='screener'). Any
    per-symbol failure collapses into an error row so the sweep continues.
    """
    async with sem:
        try:
            vi = await fetch_valuation_input(symbol)
            result = value(vi)
        except Exception as e:  # noqa: BLE001 - one bad symbol never aborts the sweep
            return ScreenRow(symbol=symbol, error=str(e) or type(e).__name__)
    await record_valuation_snapshot(result, source="screener")
    return ScreenRow(
        symbol=symbol,
        fair_value=result.fair_value,
        current_price=result.current_price,
        margin_of_safety_pct=result.margin_of_safety_pct,
        data_quality=result.data_quality,
        veto=result.veto.triggered,
    )


@router.get(
    "/valuation/screen",
    response_model=ScreenResponse,
    dependencies=[Depends(require_internal_bearer)],
)
async def screen_valuations(
    symbols: str | None = Query(
        None,
        description="Comma-separated symbol override; omit to use the moomoo watchlist",
    ),
    opend: OpendAdapter = Depends(get_opend),
) -> ScreenResponse:
    warnings: list[str] = []
    requested = [s.strip() for s in (symbols or "").split(",") if s.strip()]
    if requested:
        source: Literal["watchlist", "symbols"] = "symbols"
        candidates = requested
    else:
        source = "watchlist"
        try:
            items = await asyncio.to_thread(opend.list_watchlist)
            candidates = [item.code for item in items]
        except Exception as e:  # noqa: BLE001 - degrade, the caller can retry with ?symbols=
            warnings.append(f"watchlist unavailable: {e}")
            candidates = []

    seen: set[str] = set()
    unique = [s for s in candidates if not (s in seen or seen.add(s))]
    total = len(unique)
    truncated = total > _SCREEN_MAX_SYMBOLS
    if truncated:
        warnings.append(
            f"symbol list truncated to first {_SCREEN_MAX_SYMBOLS} of {total}"
        )
        unique = unique[:_SCREEN_MAX_SYMBOLS]

    sem = asyncio.Semaphore(_SCREEN_CONCURRENCY)
    rows = list(await asyncio.gather(*(_screen_one(sem, s) for s in unique)))
    rows.sort(key=_screen_sort_key)
    return ScreenResponse(
        rows=rows,
        total_symbols=total,
        truncated=truncated,
        source=source,
        warnings=warnings,
    )
