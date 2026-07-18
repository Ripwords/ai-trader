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

import asyncio
import inspect
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Literal, Protocol

from .model_config import build_tradingagents_config


Outcome = Literal["correct", "wrong", "neutral"]


@dataclass
class RealizedReturn:
    realized_return: float
    benchmark_return: float
    alpha: float
    outcome: Outcome
    # Symbol close at the horizon exit — feeds the valuation-error note
    # (fair value vs what the price actually did). None when unknown
    # (e.g. the placeholder written on a failed price fetch).
    realized_price: float | None = None


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


def _bar_date(bar: dict[str, Any]) -> date | None:
    """Extract the bar's date as a :class:`date`.

    Test fixtures use ``time_key`` (the moomoo SDK's native field); the
    production :class:`Bar` pydantic model uses ``time`` (a datetime). We
    accept either — checking ``time_key`` first to keep existing tests
    deterministic — and tolerate date-only ISO strings, full ISO datetimes,
    and :class:`datetime` instances. Returns ``None`` for malformed bars so
    the caller can skip them rather than raise.
    """
    raw = bar.get("time_key", bar.get("time"))
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    try:
        return date.fromisoformat(text[:10])
    except ValueError:
        try:
            return datetime.fromisoformat(text).date()
        except ValueError:
            return None


def _closest_bar_at_or_after(bars: list[dict], target: date) -> dict | None:
    """Return the first bar with ``time_key`` >= ``target`` (i.e. trade_date).

    The realized-return contract is "buy at the first available close on or
    after the decision day"; weekends and holidays mean the trade_date may
    fall on a non-trading day, so we walk forward to the first qualifying
    bar.
    """
    for bar in bars:
        d = _bar_date(bar)
        if d is not None and d >= target:
            return bar
    return None


def _closest_bar_at_or_before(bars: list[dict], target: date) -> dict | None:
    """Return the last bar with ``time_key`` <= ``target`` (i.e. exit day).

    The exit is "sell at the close on the horizon day"; if the horizon day
    is a non-trading day, we fall back to the most recent prior trading
    close. Since :func:`compute_realized_return` may be called before the
    horizon has even elapsed (in which case the latest bar is the best we
    have), this handles both "horizon in the past" and "horizon already
    happened" cases uniformly.
    """
    candidate: dict | None = None
    for bar in bars:
        d = _bar_date(bar)
        if d is None:
            continue
        if d <= target:
            candidate = bar
        else:
            break
    return candidate


async def _maybe_await_kline(
    opend: Any, symbol: str, *, ktype: str, num: int
) -> list[dict]:
    """Fetch ``num`` daily bars whether ``opend.get_kline`` is sync or async.

    The production :class:`OpendAdapter` is synchronous (it wraps the moomoo
    OpenQuoteContext, which is itself blocking). The toolkit was originally
    written against an async client; tests mock with :class:`AsyncMock`. We
    accommodate both shapes here so the reflection job degrades gracefully
    against either: an awaitable result is awaited, otherwise the bare
    return value is used. Sync calls are routed through
    :func:`asyncio.to_thread` so we don't block the event loop.

    Returns a list of bar dicts (``[{time_key, close, ...}, ...]``).
    Production OpendAdapter returns a :class:`KLineResponse`; if so, fall
    back to ``.bars`` and convert each :class:`Bar` model to a dict.
    """
    if inspect.iscoroutinefunction(getattr(opend, "get_kline", None)):
        result = await opend.get_kline(symbol, ktype=ktype, num=num)
    else:
        result = await asyncio.to_thread(
            opend.get_kline, symbol, ktype=ktype, num=num
        )
    # AsyncMock-backed tests usually surface a list directly. Production's
    # OpendAdapter wraps bars in a KLineResponse pydantic model with a
    # ``.bars`` attribute; coerce.
    if isinstance(result, list):
        return result
    bars = getattr(result, "bars", None)
    if bars is None:
        return []
    return [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in bars]


async def compute_realized_return(
    opend: _OpenDLike,
    symbol: str,
    trade_date: date,
    rating: str,
    horizon_days: int,
) -> RealizedReturn:
    """Compute alpha vs SPY over the ``[trade_date, trade_date + horizon_days]`` window.

    Bars are fetched via :func:`_maybe_await_kline`; we ask for enough
    history to cover ``trade_date`` even when the decision is N days old:
    ``num = max(horizon_days + 5, days_since_trade + horizon_days + 10)``.
    Window slicing is by ``time_key``, so weekends/holidays are tolerated
    on either end.

    Raises :class:`ValueError` when bars don't cover the trade_date (the
    caller logs ``[reflection failed: insufficient history for trade_date X]``
    which surfaces in the UI).
    """
    today = date.today()
    days_since = max(0, (today - trade_date).days)
    num = max(horizon_days + 5, days_since + horizon_days + 10)

    sym_bars = await _maybe_await_kline(opend, symbol, ktype="K_DAY", num=num)
    spy_bars = await _maybe_await_kline(opend, "US.SPY", ktype="K_DAY", num=num)
    if not sym_bars or not spy_bars:
        raise ValueError(f"insufficient bars to compute return for {symbol}")

    horizon_date = trade_date + timedelta(days=horizon_days)

    sym_entry = _closest_bar_at_or_after(sym_bars, trade_date)
    sym_exit = _closest_bar_at_or_before(sym_bars, horizon_date)
    spy_entry = _closest_bar_at_or_after(spy_bars, trade_date)
    spy_exit = _closest_bar_at_or_before(spy_bars, horizon_date)

    if not (sym_entry and sym_exit and spy_entry and spy_exit):
        raise ValueError(
            f"insufficient history for trade_date {trade_date.isoformat()} "
            f"+ horizon {horizon_days}d for {symbol}"
        )
    # When entry == exit (e.g. only one bar in the window, or horizon hasn't
    # elapsed), the return is 0 — that's still a meaningful "no movement"
    # data point and we don't want to raise.
    sym_ret = (sym_exit["close"] / sym_entry["close"] - 1) * 100
    spy_ret = (spy_exit["close"] / spy_entry["close"] - 1) * 100
    alpha = sym_ret - spy_ret
    return RealizedReturn(
        realized_return=round(sym_ret, 4),
        benchmark_return=round(spy_ret, 4),
        alpha=round(alpha, 4),
        outcome=_classify_outcome(rating, alpha),
        realized_price=round(float(sym_exit["close"]), 6),
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


# Pending = decisions for which not every role has a reflection yet AND the
# decision is at least horizon_days old. We expect 5 reflections per
# decision (one per role); ``EXISTS`` short-circuits so a fully reflected
# decision is excluded once any single role has all 5 rows. The DISTINCT
# guard is in case multiple roles trail behind — we want the decision once
# regardless. LIMIT 50 keeps a single reflect pass bounded.
_PENDING_SQL = """
SELECT d.id, d.run_id, d.user_id, d.symbol, d.trade_date,
       d.rating, d.confidence, d.rationale, d.created_at,
       r_count.count AS reflection_count,
       run.final_state AS final_state
FROM agent_decisions d
JOIN agent_runs run ON run.id = d.run_id
LEFT JOIN LATERAL (
  SELECT COUNT(*) AS count FROM agent_reflections WHERE decision_id = d.id
) r_count ON TRUE
WHERE r_count.count < 5
  AND d.created_at <= now() - ($1 || ' days')::interval
LIMIT 50
"""


# The five roles TradingAgents' Reflector writes lessons for. The router
# seeds each role's FinancialSituationMemory at run start from the matching
# slice of these reflections, so per-role lessons stay in their own pool
# and don't contaminate sibling agents' prompts.
_REFLECTION_ROLES: tuple[tuple[str, str, str], ...] = (
    # role-key                  AgentState source field           role-prefix in prompt
    ("trader",          "trader_investment_plan",                 "TRADER"),
    ("bull_researcher", "bull_history",                            "BULL RESEARCHER"),
    ("bear_researcher", "bear_history",                            "BEAR RESEARCHER"),
    ("invest_judge",    "investment_judge_decision",               "RESEARCH JUDGE"),
    ("risk_manager",    "risk_judge_decision",                     "RISK MANAGER"),
)


# Roles whose run-time prompts included the deterministic valuation summary
# (see graph.run_graph's memory seeding) — only they get the post-hoc
# valuation-error note, so the feedback lands where the context existed.
_VALUATION_NOTE_ROLES: frozenset[str] = frozenset({"invest_judge", "risk_manager"})


def _format_valuation_note(
    fair_value: float,
    mos_pct: float | None,
    realized_price: float,
    horizon_days: int,
) -> str:
    """One compact line comparing the DCF fair value to the realized price.

    The 'valuation error' is (fair_value - realized_price) / realized_price:
    a positive error means the DCF called the stock worth more than the
    market subsequently priced it — too optimistic (beyond a 10% tolerance
    band; inside the band it was 'about right').
    """
    err = (fair_value - realized_price) / realized_price
    if err > 0.10:
        verdict = f"too optimistic (fair value {err:.1%} above the realized price)"
    elif err < -0.10:
        verdict = f"too pessimistic (fair value {abs(err):.1%} below the realized price)"
    else:
        verdict = f"about right (within {abs(err):.1%})"
    mos_part = f" (MoS {mos_pct:.1%})" if mos_pct is not None else ""
    return (
        f"valuation called fair value {fair_value:.2f}{mos_part}; "
        f"price at the {horizon_days}d horizon was {realized_price:.2f} — "
        f"the DCF was {verdict}"
    )


# Closest-in-time snapshot at/before the decision. agent_run snapshots are
# preferred over chat/screener ones (they're what the judges actually saw
# at run time), then recency breaks ties.
_VALUATION_SNAPSHOT_SQL = """
SELECT fair_value::float AS fair_value,
       margin_of_safety_pct::float AS mos
FROM valuation_snapshots
WHERE symbol = $1 AND fair_value IS NOT NULL AND created_at <= $2
ORDER BY (source = 'agent_run') DESC, created_at DESC
LIMIT 1
"""


async def _valuation_note_for_decision(
    conn: Any,
    symbol: str,
    decision_created_at: Any,
    realized: RealizedReturn,
    horizon_days: int,
) -> str | None:
    """Look up the decision-time valuation snapshot and format the error note.

    Degrades to ``None`` on every miss: no snapshot stored, snapshot without
    a fair value, no realized price, or any query error (e.g. the
    valuation_snapshots table not yet migrated).
    """
    if realized.realized_price is None or realized.realized_price <= 0:
        return None
    try:
        row = await conn.fetchrow(
            _VALUATION_SNAPSHOT_SQL, symbol, decision_created_at
        )
    except Exception as e:  # noqa: BLE001 - the note is best-effort context
        print(f"[reflection] valuation snapshot lookup failed for {symbol}: {e}")
        return None
    if row is None or row["fair_value"] is None:
        return None
    return _format_valuation_note(
        fair_value=row["fair_value"],
        mos_pct=row["mos"],
        realized_price=realized.realized_price,
        horizon_days=horizon_days,
    )


def _role_input(final_state: dict[str, Any] | None, source_field: str) -> str:
    """Pull the per-role input text out of ``agent_runs.final_state``.

    The keys we care about live one level deeper for the debate-state ones
    (e.g. ``investment_debate_state.bull_history``); the rest are top-level.
    """
    if not final_state:
        return ""
    if source_field == "bull_history":
        return (final_state.get("investment_debate_state") or {}).get("bull_history", "")
    if source_field == "bear_history":
        return (final_state.get("investment_debate_state") or {}).get("bear_history", "")
    if source_field == "investment_judge_decision":
        return (final_state.get("investment_debate_state") or {}).get("judge_decision", "")
    if source_field == "risk_judge_decision":
        return (final_state.get("risk_debate_state") or {}).get("judge_decision", "")
    return final_state.get(source_field, "")


def _role_reflection_prompt(
    role_prefix: str,
    role_input: str,
    realized: RealizedReturn,
    valuation_note: str | None = None,
) -> str:
    """Build the role-specific reflection prompt.

    ``valuation_note`` (when present) is the compact fair-value-vs-realized
    line — only passed for the roles that saw the valuation summary at run
    time (invest_judge, risk_manager), so the lesson can call out whether
    the DCF anchored them well or poorly.
    """
    valuation_part = (
        f"Deterministic valuation check: {valuation_note}\n" if valuation_note else ""
    )
    return (
        f"You are reflecting on the {role_prefix}'s past contribution to a trading "
        f"decision so future {role_prefix.lower()}s on similar setups make better "
        f"calls.\n\n"
        f"{role_prefix} analysis/decision:\n{role_input[:4000]}\n\n"
        f"Realized return: {realized.realized_return:+.2f}%\n"
        f"Benchmark (SPY): {realized.benchmark_return:+.2f}%\n"
        f"Alpha: {realized.alpha:+.2f}%\n"
        f"Outcome: {realized.outcome}\n"
        f"{valuation_part}\n"
        f"In 2-3 sentences, write a concrete lesson SPECIFICALLY for the "
        f"{role_prefix}. Reference what they argued or recommended; don't "
        f"speak about the overall trade. Output the lesson only — no preamble."
    )


async def _write_role_reflection(
    role_prefix: str,
    role_input: str,
    realized: RealizedReturn,
    valuation_note: str | None = None,
) -> str:
    """Ask the quick LLM for a role-specific 2-3 sentence lesson.

    Mirrors :func:`write_reflection_text` but with role context baked in so
    the lesson reads as advice to *that* role specifically. Lessons land
    keyed by role in agent_reflections; at next run, each role's
    FinancialSituationMemory gets seeded from its own slice.
    """
    if not role_input.strip():
        # The role didn't run (e.g. ``social`` was skipped via
        # selected_analysts) — record an empty placeholder so the
        # decision counts as fully reflected.
        return f"[{role_prefix} did not run for this decision; no input to reflect on]"

    chat = _build_chat_for_quick_model()
    prompt = _role_reflection_prompt(role_prefix, role_input, realized, valuation_note)
    msg = await chat.ainvoke(prompt)
    content = msg.content if isinstance(msg.content, str) else str(msg.content)
    return content.strip()


async def reflect_pending(
    pool: Any, opend: _OpenDLike | None, *, horizon_days: int = 7
) -> int:
    """Write one reflection PER ROLE per pending decision.

    Returns the number of reflection ROWS written (5 × number of decisions
    when everything goes through). A decision counts as fully reflected
    once all five role rows exist; the next pass skips it.

    Failures inside the per-decision block (price fetch, LLM call)
    collapse into a placeholder reflection per role so a single broken
    decision doesn't block the rest of the batch.
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
            except Exception as e:  # noqa: BLE001
                realized = RealizedReturn(0.0, 0.0, 0.0, "neutral")
                fallback = f"[reflection failed: {e}]"
                # On any pre-LLM error, write a placeholder for every role
                # so the decision exits the pending set.
                for role, _src, _prefix in _REFLECTION_ROLES:
                    await _insert_reflection(
                        conn, row["id"], role, horizon_days, realized, fallback
                    )
                    n += 1
                continue

            # Valuation feedback: compare the decision-time DCF fair value
            # (closest stored snapshot) against the realized price at the
            # horizon. None when no snapshot exists — reflections proceed
            # exactly as before.
            valuation_note = await _valuation_note_for_decision(
                conn, row["symbol"], row["created_at"], realized, horizon_days
            )

            final_state = row["final_state"] or {}
            # ``final_state`` is jsonb; asyncpg may surface it as dict OR
            # str depending on codec registration. Coerce to dict.
            if isinstance(final_state, str):
                import json as _json
                try:
                    final_state = _json.loads(final_state)
                except _json.JSONDecodeError:
                    final_state = {}
            for role, source_field, role_prefix in _REFLECTION_ROLES:
                role_input = _role_input(final_state, source_field)
                note = valuation_note if role in _VALUATION_NOTE_ROLES else None
                try:
                    text = await _write_role_reflection(
                        role_prefix, role_input, realized, valuation_note=note
                    )
                except Exception as e:  # noqa: BLE001
                    text = f"[{role_prefix} reflection failed: {e}]"
                await _insert_reflection(
                    conn, row["id"], role, horizon_days, realized, text
                )
                n += 1
    return n


async def _insert_reflection(
    conn: Any,
    decision_id: Any,
    role: str,
    horizon_days: int,
    realized: RealizedReturn,
    text: str,
) -> None:
    """Single insert into agent_reflections (decision_id, role) UNIQUE."""
    await conn.execute(
        "INSERT INTO agent_reflections"
        "(id, decision_id, role, horizon_days, realized_return, "
        " benchmark_return, alpha, outcome, text) "
        "VALUES(gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) "
        "ON CONFLICT (decision_id, role) DO NOTHING",
        decision_id,
        role,
        horizon_days,
        realized.realized_return,
        realized.benchmark_return,
        realized.alpha,
        realized.outcome,
        text,
    )
