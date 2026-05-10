"""POST /agents/run — synchronous NDJSON stream of a TradingAgents run.

No persistence yet; events go to the wire and that's it. Cost-cap and
checkpointer wiring land in later tasks.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import date as date_t
from typing import AsyncIterator

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.schemas.agents import RunRequest
from app.services.agents import graph as graph_mod
from app.services.agents.cost_cap import DailyCapExceeded
from app.services.agents.streaming import translate_chunks
from app.settings import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agents", tags=["agents"])


def _check_bearer(authorization: str | None) -> None:
    settings = get_settings()
    if authorization != f"Bearer {settings.INTERNAL_BEARER}":
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.post("/run")
async def run_agents(
    body: RunRequest,
    request: Request,
    authorization: str | None = Header(default=None),
) -> StreamingResponse:
    _check_bearer(authorization)
    run_id = str(uuid.uuid4())
    trade_date = body.trade_date or date_t.today()

    async def _stream() -> AsyncIterator[bytes]:
        opend = getattr(request.app.state, "opend_client", None)
        graph = graph_mod.build_graph(
            opend,
            max_debate_rounds=body.max_debate_rounds,
            deep_thinking=body.deep_thinking,
        )
        config = {
            "max_debate_rounds": body.max_debate_rounds,
            "deep_thinking": body.deep_thinking,
            # ``graph`` may be an opaque test double; only real
            # TradingAgentsGraph instances expose ``.config``.
            "models": getattr(getattr(graph, "config", None), "llm_provider", None),
        }
        try:
            async for event in translate_chunks(
                graph_mod.run_graph(
                    graph,
                    body.symbol,
                    trade_date,
                    body.max_debate_rounds,
                    body.deep_thinking,
                ),
                run_id=run_id,
                symbol=body.symbol,
                config=config,
            ):
                # request.is_disconnected exists on FastAPI's Request and is
                # cheap to call between events; saves us continuing a paid run
                # after the client gives up.
                if await request.is_disconnected():
                    return
                yield (json.dumps(event) + "\n").encode()
        except DailyCapExceeded as e:
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        except Exception as e:  # noqa: BLE001  # surface any error to the client as an event
            logger.exception("agents run failed: %s", e)
            yield (json.dumps({"type": "error", "message": str(e)}) + "\n").encode()
        finally:
            yield (
                json.dumps(
                    {
                        "type": "run-end",
                        "run_id": run_id,
                        "tokens_in": 0,
                        "tokens_out": 0,
                        "cost_usd": 0.0,
                    }
                )
                + "\n"
            ).encode()

    return StreamingResponse(_stream(), media_type="application/x-ndjson")
