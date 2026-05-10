"""Nightly reflection job — realized return vs SPY, fed back as memory.

Two layers:

* :func:`compute_realized_return` — pure async function that fetches N+5
  daily bars for the symbol and SPY via the OpenD client and computes the
  alpha (symbol return minus benchmark return). Easy to unit test by
  injecting a stub client. The classifier (:func:`_classify_outcome`) maps
  ``rating + alpha`` to ``correct | wrong | neutral``.

* :func:`reflect_pending` — orchestrator. Selects all ``agent_decisions``
  rows older than ``horizon_days`` that don't yet have a paired
  ``agent_reflections`` row, computes alpha for each, asks the quick LLM
  for a 2-3 sentence lesson, and writes the reflection. Failures don't
  abort the loop — they get a placeholder text and ``neutral`` outcome so
  the row still exists (and won't be retried).

The endpoint glue (POST ``/agents/reflect``) lives in
``app/routers/agents.py``; the daily trigger is the ``agents-cron``
docker service, which is just curl-on-a-schedule.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Literal, Protocol

from .model_config import build_tradingagents_config


Outcome = Literal["correct", "wrong", "neutral"]


@dataclass
class RealizedReturn:
    realized_return: float
    benchmark_return: float
    alpha: float
    outcome: Outcome


class _OpenDLike(Protocol):
    """Subset of the async OpenD client this module relies on."""

    async def get_kline(
        self, ticker: str, ktype: str, num: int
    ) -> list[dict[str, Any]]: ...


def _classify_outcome(rating: str, alpha: float) -> Outcome:
    """Map ``rating + alpha`` to an outcome label.

    Precedence matters:
    * Small alpha (|alpha| < 0.5) is neutral, *except* for ``hold`` which is
      'correct' when the move was small (the trader called it right).
    * Bullish ratings (buy/strong-buy) with positive alpha → correct.
    * Bearish ratings (sell/reduce) with negative alpha → correct.
    * ``hold`` with |alpha| < 1.0 → correct (a slightly larger band, still
      a reasonable hold). Otherwise → wrong.
    """
    if abs(alpha) < 0.5:
        if rating == "hold":
            return "correct"
        return "neutral"
    if rating in ("strong-buy", "buy") and alpha > 0:
        return "correct"
    if rating in ("sell", "reduce") and alpha < 0:
        return "correct"
    if rating == "hold" and abs(alpha) < 1.0:
        return "correct"
    return "wrong"


async def compute_realized_return(
    opend: _OpenDLike,
    symbol: str,
    trade_date: date,
    rating: str,
    horizon_days: int,
) -> RealizedReturn:
    """Compute alpha vs SPY over ``horizon_days`` of daily bars.

    ``trade_date`` isn't currently fed to the OpenD call (the OpenD client
    surfaces "latest N bars"); we ask for ``horizon_days + 5`` bars to ride
    over weekends/holidays and use the first/last close of the returned
    window. Bars are dicts with at least a ``close`` key.

    Raises ``ValueError`` if either series is empty.
    """
    sym_bars = await opend.get_kline(symbol, ktype="K_DAY", num=horizon_days + 5)
    spy_bars = await opend.get_kline("US.SPY", ktype="K_DAY", num=horizon_days + 5)
    if not sym_bars or not spy_bars:
        raise ValueError(f"insufficient bars to compute return for {symbol}")
    sym_ret = (sym_bars[-1]["close"] / sym_bars[0]["close"] - 1) * 100
    spy_ret = (spy_bars[-1]["close"] / spy_bars[0]["close"] - 1) * 100
    alpha = sym_ret - spy_ret
    return RealizedReturn(
        realized_return=round(sym_ret, 4),
        benchmark_return=round(spy_ret, 4),
        alpha=round(alpha, 4),
        outcome=_classify_outcome(rating, alpha),
    )


def _build_chat_for_quick_model() -> Any:
    """Provider-aware chat factory for the reflection text-write step.

    Mirrors the provider routing in ``model_config``. We use the *quick*
    (cheaper, smaller) model for reflections — they're short and the cost
    per reflection should be negligible.
    """
    cfg = build_tradingagents_config()
    provider = cfg["llm_provider"]
    model_id = cfg["quick_think_llm"]
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=model_id, temperature=0.2, max_tokens=400)
    if provider == "openai":
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(model=model_id, temperature=0.2, max_tokens=400)
    if provider == "google":
        from langchain_google_genai import ChatGoogleGenerativeAI

        return ChatGoogleGenerativeAI(
            model=model_id, temperature=0.2, max_output_tokens=400
        )
    if provider == "deepseek":
        # DeepSeek exposes an OpenAI-compatible API; route via langchain-openai
        # with the base_url override.
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=model_id,
            base_url="https://api.deepseek.com",
            temperature=0.2,
            max_tokens=400,
        )
    raise ValueError(f"Unsupported provider {provider!r}")


async def write_reflection_text(
    decision_summary: str, realized: RealizedReturn
) -> str:
    """Ask the quick LLM for a 2-3 sentence lesson. Real network call."""
    chat = _build_chat_for_quick_model()
    prompt = (
        f"You're reflecting on a past trading decision.\n\n"
        f"Decision: {decision_summary}\n"
        f"Realized return: {realized.realized_return:+.2f}%\n"
        f"Benchmark (SPY): {realized.benchmark_return:+.2f}%\n"
        f"Alpha: {realized.alpha:+.2f}%\n"
        f"Outcome: {realized.outcome}\n\n"
        f"In 2-3 sentences, write a concrete lesson for next time. "
        f"Be specific about what the agents got right or wrong."
    )
    msg = await chat.ainvoke(prompt)
    content = msg.content if isinstance(msg.content, str) else str(msg.content)
    return content.strip()


# Pending = decisions older than ``horizon_days`` with no paired reflection.
# ``$1`` is the horizon string-coerced for the interval cast (asyncpg can't
# pass an int as an interval). LIMIT 50 keeps a single reflect pass bounded.
_PENDING_SQL = """
SELECT d.id, d.run_id, d.user_id, d.symbol, d.trade_date, d.rating, d.confidence, d.rationale
FROM agent_decisions d
LEFT JOIN agent_reflections r ON r.decision_id = d.id
WHERE r.id IS NULL
  AND d.created_at <= now() - ($1 || ' days')::interval
LIMIT 50
"""


async def reflect_pending(
    pool: Any, opend: _OpenDLike | None, *, horizon_days: int = 7
) -> int:
    """Process all pending decisions; insert one reflection row per decision.

    Returns the count of reflections written. Failures inside the per-row
    block (price fetch, LLM call) collapse into a placeholder reflection so
    a single broken decision doesn't block the rest of the batch.
    """
    n = 0
    async with pool.acquire() as conn:
        rows = await conn.fetch(_PENDING_SQL, str(horizon_days))
        for row in rows:
            try:
                if opend is None:
                    raise RuntimeError("opend client unavailable")
                realized = await compute_realized_return(
                    opend=opend,
                    symbol=row["symbol"],
                    trade_date=row["trade_date"],
                    rating=row["rating"],
                    horizon_days=horizon_days,
                )
                summary = (
                    f"{row['rating']} {row['symbol']} on {row['trade_date']}: "
                    f"{row['rationale'][:200]}"
                )
                text = await write_reflection_text(summary, realized)
            except Exception as e:  # noqa: BLE001
                text = f"[reflection failed: {e}]"
                realized = RealizedReturn(0.0, 0.0, 0.0, "neutral")
            await conn.execute(
                "INSERT INTO agent_reflections"
                "(id, decision_id, horizon_days, realized_return, "
                " benchmark_return, alpha, outcome, text) "
                "VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)",
                row["id"],
                horizon_days,
                realized.realized_return,
                realized.benchmark_return,
                realized.alpha,
                realized.outcome,
                text,
            )
            n += 1
    return n
