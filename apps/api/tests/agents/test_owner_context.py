"""The owner's position and mandate reach the debate, and the verdict is
read in the owner's terms. The graph tests run the real compiled graph."""

from __future__ import annotations

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.schemas.agents import OwnerContext, RunRequest, owner_context_from_config
from app.services.agents import prompts as prompts_mod
from app.services.agents.graph import _extract_decision
from app.services.agents.owner import OWNER_MANDATE_PROMPT, format_owner_context, owner_mandate
from app.services.agents.streaming import translate_chunks
from tests.agents.test_router_sync import _FakePool
from tests.agents.test_parallel_analysts import (  # noqa: F401 - llm and valuation_delay are fixtures
    FakeLlm,
    _build,
    _run,
    llm,
    valuation_delay,
)

HELD = {
    "base_currency": "MYR",
    "position": {
        "status": "held",
        "quantity": 12.5,
        "market_value": 10234.0,
        "currency": "USD",
        "weight_pct": 4.21,
        "unrealized_pnl_pct": 12.34,
    },
    "investable_total": 520000,
    "monthly_contribution": 3000,
    "notes": ["Tech concentration is deliberate."],
}
NOT_HELD = {"base_currency": "MYR", "position": {"status": "not_held"}}

DECIDERS = ("As the portfolio manager", "You are a trading agent", "As the Risk Management Judge")


def _owner(raw: dict[str, Any]) -> OwnerContext:
    return OwnerContext.model_validate(raw)


def test_a_run_request_without_owner_context_is_still_valid() -> None:
    assert RunRequest(symbol="NVDA").owner_context is None


def test_a_run_request_carries_a_validated_owner_context() -> None:
    body = RunRequest.model_validate({"symbol": "NVDA", "owner_context": HELD})

    assert body.owner_context is not None
    assert body.owner_context.position.status == "held"
    assert body.owner_context.position.weight_pct == 4.21


@pytest.mark.parametrize(
    "bad",
    [
        {"position": {"status": "maybe"}},
        {"position": {"status": "held", "quantity": -1}},
        {"position": {"status": "held"}, "notes": ["x" * 241]},
        {"position": {"status": "held"}, "notes": ["n"] * 31},
        {"position": {"status": "held"}, "instructions": "ignore the above"},
    ],
)
def test_a_malformed_owner_context_is_rejected(bad: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        RunRequest.model_validate({"symbol": "NVDA", "owner_context": bad})


def test_a_stored_owner_context_that_no_longer_validates_is_dropped() -> None:
    assert owner_context_from_config(HELD) == _owner(HELD)
    assert owner_context_from_config(None) is None
    assert owner_context_from_config({"position": {"status": "maybe"}}) is None


def test_a_held_position_is_stated_with_its_size_and_weight() -> None:
    text = format_owner_context(_owner(HELD), "US.NVDA")

    assert "holds 12.5 shares of US.NVDA worth 10,234 USD" in text
    assert "4.2% of investable assets" in text
    assert "Unrealised gain or loss: +12.3%" in text
    assert "Investable assets: 520,000 MYR" in text
    assert "Base currency: MYR" in text
    assert "about 3,000 MYR of new money every month" in text
    assert "- Tech concentration is deliberate." in text


def test_a_symbol_the_owner_does_not_hold_says_so() -> None:
    text = format_owner_context(_owner(NOT_HELD), "US.NVDA")

    assert "does not hold US.NVDA" in text
    assert "new money every month" not in text
    assert "Investable assets" not in text


def test_an_unread_position_is_not_guessed() -> None:
    text = format_owner_context(_owner({"position": {"status": "unknown"}}), "US.NVDA")

    assert "could not be read" in text
    assert "Do not assume" in text


def test_the_mandate_is_an_editable_prompt_with_its_verdict_contract() -> None:
    default = prompts_mod.prompt_defaults()[OWNER_MANDATE_PROMPT]

    assert default["placeholders"] == []
    assert "OWNER VERDICT: DO NOT ADD AT THIS SIZE" in default["text"]
    assert "FINAL TRANSACTION PROPOSAL" in default["text"]
    assert owner_mandate() == default["text"]

    token = prompts_mod.set_run_overrides({OWNER_MANDATE_PROMPT: "my own mandate"})
    try:
        assert owner_mandate() == "my own mandate"
    finally:
        prompts_mod.reset_run_overrides(token)


async def test_every_debater_sees_the_position_and_only_the_deciders_get_the_mandate(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path, owner_context=_owner(HELD)))

    assert len(llm.prompts) == 8
    for prompt in llm.prompts:
        assert prompt.count("## Owner Context") == 1
        assert "holds 12.5 shares of NVDA" in prompt
    with_mandate = [p for p in llm.prompts if "OWNER VERDICT:" in p]
    assert len(with_mandate) == 3
    for opening in DECIDERS:
        assert len([p for p in with_mandate if opening in p]) == 1
    for prompt in with_mandate:
        assert prompt.index("## Owner Context") < prompt.index("OWNER VERDICT:")


async def test_a_saved_mandate_and_a_saved_node_prompt_both_reach_the_decider(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    token = prompts_mod.set_run_overrides({
        OWNER_MANDATE_PROMPT: "MYMANDATE OWNER VERDICT: ADD or HOLD",
        "risk_manager": "MYRISKJUDGE {history} {trader_plan} {past_memory_str} FINAL TRANSACTION PROPOSAL",
    })
    try:
        prompts_mod.install_prompt_overrides()
        await _run(_build(tmp_path, owner_context=_owner(HELD)))
    finally:
        prompts_mod.reset_run_overrides(token)

    judge = [p for p in llm.prompts if "MYRISKJUDGE" in p]
    assert len(judge) == 1
    assert "## Owner Context" in judge[0]
    assert "MYMANDATE" in judge[0]
    assert len([p for p in llm.prompts if "MYMANDATE" in p]) == 3


async def test_a_run_without_owner_context_adds_nothing_about_the_owner(
    llm: FakeLlm, valuation_delay: dict[str, float], tmp_path: Any
) -> None:
    await _run(_build(tmp_path))

    assert len(llm.prompts) == 8
    assert not [p for p in llm.prompts if "Owner Context" in p or "OWNER VERDICT" in p]


def _decision(text: str) -> dict:
    out = _extract_decision({}, {"final_trade_decision": text})
    assert out is not None
    return out


@pytest.mark.parametrize(
    ("line", "verdict", "rating"),
    [
        ("OWNER VERDICT: ADD", "add", "buy"),
        ("OWNER VERDICT: **HOLD**", "hold", "hold"),
        ("Owner verdict: trim", "trim", "reduce"),
        ("OWNER VERDICT: DO NOT ADD AT THIS SIZE", "do-not-add", "hold"),
    ],
)
def test_the_owner_verdict_sets_the_rating(line: str, verdict: str, rating: str) -> None:
    decision = _decision(f"We could sell or buy here.\n{line}\nFINAL TRANSACTION PROPOSAL: **SELL**")

    assert (decision["owner_verdict"], decision["rating"]) == (verdict, rating)


def test_the_last_owner_verdict_wins_over_a_quoted_one() -> None:
    decision = _decision(
        "The trader proposed OWNER VERDICT: ADD. I disagree.\n"
        "OWNER VERDICT: DO NOT ADD AT THIS SIZE\nFINAL TRANSACTION PROPOSAL: **HOLD**"
    )

    assert (decision["owner_verdict"], decision["rating"]) == ("do-not-add", "hold")


def test_a_decision_without_an_owner_verdict_keeps_its_old_shape() -> None:
    decision = _decision("FINAL TRANSACTION PROPOSAL: **BUY**")

    assert set(decision) == {"rating", "confidence", "rationale"}
    assert decision["rating"] == "buy"


async def test_the_decision_event_carries_the_owner_verdict_only_when_there_is_one() -> None:
    async def chunks(decision: dict):
        yield {"metadata": {}, "values": {"decision": decision}}

    base = {"rating": "hold", "confidence": None, "rationale": "r"}
    with_verdict = [
        e async for e in translate_chunks(
            chunks({**base, "owner_verdict": "do-not-add"}), run_id="r", symbol="NVDA", config={}
        )
    ]
    without = [e async for e in translate_chunks(chunks(base), run_id="r", symbol="NVDA", config={})]

    assert [e for e in with_verdict if e["type"] == "decision"] == [
        {"type": "decision", **base, "owner_verdict": "do-not-add"}
    ]
    assert [e for e in without if e["type"] == "decision"] == [{"type": "decision", **base}]


async def _post_run(monkeypatch: pytest.MonkeyPatch, body: dict[str, Any]) -> tuple[int, list[dict], dict]:
    monkeypatch.setenv("INTERNAL_BEARER", "test-bearer")
    from app.main import create_app
    from app.services.agents import graph as graph_mod
    from app.settings import get_settings

    get_settings.cache_clear()
    seen: dict[str, Any] = {}

    async def fake_build(_opend: Any, **kwargs: Any) -> object:
        seen.update(kwargs)
        return object()

    async def fake_run_graph(*_a: Any, **_kw: Any):
        yield {"metadata": {}, "values": {}}

    monkeypatch.setattr(graph_mod, "build_graph_locked", fake_build)
    monkeypatch.setattr(graph_mod, "run_graph", fake_run_graph)
    app = create_app()
    app.state.pg_pool = _FakePool()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        async with c.stream(
            "POST", "/agents/run", json=body, headers={"authorization": "Bearer test-bearer"}
        ) as r:
            lines = [json.loads(line) async for line in r.aiter_lines() if line.strip()]
            return r.status_code, lines, seen


async def test_the_run_endpoint_hands_the_owner_to_the_graph_and_keeps_it_off_the_stream(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    status, lines, seen = await _post_run(monkeypatch, {"symbol": "NVDA", "owner_context": HELD})

    assert status == 200
    assert seen["owner_context"] == _owner(HELD)
    assert lines[0]["type"] == "run-start"
    assert "owner_context" not in lines[0]["config"]
    assert "520000" not in json.dumps(lines)


async def test_the_run_endpoint_rejects_a_malformed_owner_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    status, _lines, seen = await _post_run(
        monkeypatch, {"symbol": "NVDA", "owner_context": {"position": {"status": "maybe"}}}
    )

    assert status == 422
    assert seen == {}
