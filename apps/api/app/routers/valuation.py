from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Query

from app.services.valuation.compose import value
from app.services.valuation.fetch import fetch_valuation_input
from app.services.valuation.models import ValuationResult, Veto
from app.services.valuation.persist import record_valuation_snapshot

router = APIRouter(tags=["valuation"])


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
