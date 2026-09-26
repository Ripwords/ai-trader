"""The deterministic valuation summary reaches only the two judges' memories."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from app.services.agents.graph import _seed_valuation_context


class _Memory:
    def __init__(self) -> None:
        self.pairs: list[tuple[str, str]] = []

    def add_situations(self, pairs: list[tuple[str, str]]) -> None:
        self.pairs.extend(pairs)


def _graph() -> SimpleNamespace:
    return SimpleNamespace(
        trader_memory=_Memory(),
        bull_memory=_Memory(),
        bear_memory=_Memory(),
        invest_judge_memory=_Memory(),
        risk_manager_memory=_Memory(),
    )


def test_seeds_summary_into_invest_judge_and_risk_manager_only() -> None:
    g = _graph()
    _seed_valuation_context(g, "NVDA", date(2026, 9, 1), "Valuation: fair value 120")

    for mem in (g.invest_judge_memory, g.risk_manager_memory):
        assert len(mem.pairs) == 1
        situation, recommendation = mem.pairs[0]
        assert "NVDA" in situation
        assert "2026-09-01" in situation
        assert "Valuation: fair value 120" in recommendation
    for mem in (g.trader_memory, g.bull_memory, g.bear_memory):
        assert mem.pairs == []


def test_empty_summary_seeds_nothing() -> None:
    g = _graph()
    _seed_valuation_context(g, "NVDA", date(2026, 9, 1), "")
    assert g.invest_judge_memory.pairs == []
    assert g.risk_manager_memory.pairs == []
