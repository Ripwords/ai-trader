"""Sequential backtest harness for the TradingAgents pipeline.

Given a list of ``(symbol, trade_date)`` pairs, runs each through the
agents pipeline, captures the final decision, computes realized return vs
SPY over ``horizon_days``, and aggregates win-rate / alpha statistics.

Honest scope: this is a "did the methodology beat SPY on these N
historical setups?" tool, not a full portfolio simulator. We don't model
intraday fills, slippage, position sizing, capital constraints, or
multi-symbol portfolios. Each pair is treated independently; the
aggregate is just the average of per-pair alphas.

Sequential by design — concurrent runs would race the toolkit's
module-global monkey-patches and the daily cost cap. A 10-pair backtest
at typical Sonnet+Haiku rates costs ~$3-8 and takes 5-15 minutes.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.services.agents import graph as graph_mod
from app.services.agents import reflection as reflection_mod
from app.services.agents.reflection import RealizedReturn, compute_realized_return
from app.services.agents.toolkit import OpenDClient
from app.services.agents.usage import UsageAccumulator

logger = logging.getLogger(__name__)


@dataclass
class BacktestPair:
    """One historical (symbol, date) input."""

    symbol: str
    trade_date: date


@dataclass
class BacktestRunResult:
    """One pair's outcome — agent's verdict + realized return."""

    symbol: str
    trade_date: date
    rating: str
    confidence: int
    realized_return: float
    benchmark_return: float
    alpha: float
    outcome: str
    tokens_in: int
    tokens_out: int
    error: str | None = None


@dataclass
class BacktestAggregate:
    """Aggregate stats across all pair results."""

    n_runs: int = 0
    n_correct: int = 0
    n_wrong: int = 0
    n_neutral: int = 0
    total_alpha: float = 0.0
    avg_alpha: float = 0.0
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    runs: list[BacktestRunResult] = field(default_factory=list)

    @property
    def win_rate(self) -> float:
        actionable = self.n_correct + self.n_wrong
        return (self.n_correct / actionable) if actionable > 0 else 0.0


async def _consume_decision(events_iter: Any) -> tuple[str, int, str]:
    """Drain the run_graph stream and return ``(rating, confidence, rationale)``.

    The stream yields normalized chunks; we only care about the one with
    a ``decision`` payload. Defaults to ``hold`` / 50 / "" when no
    decision arrives (failed run, abort, etc).
    """
    rating, confidence, rationale = "hold", 50, ""
    async for chunk in events_iter:
        values = (chunk or {}).get("values") or {}
        d = values.get("decision")
        if d:
            rating = d.get("rating", "hold")
            confidence = int(d.get("confidence", 50))
            rationale = d.get("rationale", "")
    return rating, confidence, rationale


async def run_backtest(
    pairs: list[BacktestPair],
    *,
    opend: OpenDClient | None,
    horizon_days: int = 7,
    max_debate_rounds: int = 1,
    max_risk_discuss_rounds: int = 1,
    deep_thinking: bool = True,
    reasoning_effort: str = "medium",
    response_language: str = "en-US",
    selected_analysts: list[str] | None = None,
) -> BacktestAggregate:
    """Run each (symbol, date) sequentially. Returns aggregate stats.

    Per-pair failures (graph crash, kline fetch error, parse error)
    surface in :attr:`BacktestRunResult.error` and contribute zero to
    the alpha sum but still count toward ``n_runs`` so the user sees
    the failure rate. The next pair runs regardless.
    """
    agg = BacktestAggregate()

    for p in pairs:
        result = BacktestRunResult(
            symbol=p.symbol,
            trade_date=p.trade_date,
            rating="hold",
            confidence=0,
            realized_return=0.0,
            benchmark_return=0.0,
            alpha=0.0,
            outcome="neutral",
            tokens_in=0,
            tokens_out=0,
        )
        try:
            graph = await graph_mod.build_graph_locked(
                opend,
                max_debate_rounds=max_debate_rounds,
                max_risk_discuss_rounds=max_risk_discuss_rounds,
                deep_thinking=deep_thinking,
                reasoning_effort=reasoning_effort,
                response_language=response_language,
                selected_analysts=selected_analysts,
            )
            usage = UsageAccumulator()
            rating, confidence, _rationale = await _consume_decision(
                graph_mod.run_graph(
                    graph,
                    p.symbol,
                    p.trade_date,
                    max_debate_rounds,
                    deep_thinking,
                    memory_by_role={},
                    usage=usage,
                )
            )
            result.rating = rating
            result.confidence = confidence
            result.tokens_in = usage.tokens_in
            result.tokens_out = usage.tokens_out

            # Compute realized return vs SPY at the configured horizon. If
            # the historical horizon hasn't elapsed yet (date in the future
            # or too recent), this raises and we surface the error.
            if opend is None:
                raise RuntimeError("opend client unavailable for return calc")
            realized: RealizedReturn = await compute_realized_return(
                opend=opend,
                symbol=p.symbol,
                trade_date=p.trade_date,
                rating=rating,
                horizon_days=horizon_days,
            )
            result.realized_return = realized.realized_return
            result.benchmark_return = realized.benchmark_return
            result.alpha = realized.alpha
            result.outcome = realized.outcome
        except Exception as e:  # noqa: BLE001
            logger.warning("backtest pair %s/%s failed: %s", p.symbol, p.trade_date, e)
            result.error = str(e)

        # Roll into aggregate.
        agg.runs.append(result)
        agg.n_runs += 1
        agg.total_alpha += result.alpha
        agg.total_tokens_in += result.tokens_in
        agg.total_tokens_out += result.tokens_out
        if result.outcome == "correct":
            agg.n_correct += 1
        elif result.outcome == "wrong":
            agg.n_wrong += 1
        else:
            agg.n_neutral += 1

    if agg.n_runs > 0:
        agg.avg_alpha = agg.total_alpha / agg.n_runs

    # Suppress unused-import warning when ``reflection_mod`` isn't actually
    # touched yet — reserved for a future "auto-reflect after backtest"
    # hook that writes per-role lessons from each pair into memory so the
    # next forward run starts smarter. Keeping the import explicit here
    # signals the intent to that future hook.
    _ = reflection_mod
    return agg
