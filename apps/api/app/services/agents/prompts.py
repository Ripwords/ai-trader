"""Editable debate prompts.

The defaults are TradingAgents' own ``.md`` prompts plus our confidence judge.
Settings in the web app stores overrides; each run fetches them once, at the
start, and keeps them in a ``ContextVar`` so concurrent runs never see each
other's text. Every node module calls ``load_prompt(name)`` from its own
namespace when the node runs, so swapping that module attribute is enough to
reach every prompt without forking the package.

LangGraph runs sync nodes through ``langchain_core``'s ``run_in_executor``,
which copies the caller's context into the worker thread, so the ContextVar
set at run start is visible inside the nodes.
"""

from __future__ import annotations

import importlib
import logging
import string
from contextvars import ContextVar, Token
from typing import TypedDict

import httpx
from tradingagents.agents import prompts as ta_prompts

from app.settings import get_settings

logger = logging.getLogger(__name__)

# The node prompt name -> the module whose node loads it. ``reflector`` is
# left out: TradingAgents ships it but our runs never call it.
NODE_PROMPTS: dict[str, str] = {
    "market_analyst": "tradingagents.agents.analysts.market_analyst",
    "social_media_analyst": "tradingagents.agents.analysts.social_media_analyst",
    "news_analyst": "tradingagents.agents.analysts.news_analyst",
    "fundamentals_analyst": "tradingagents.agents.analysts.fundamentals_analyst",
    "bull_researcher": "tradingagents.agents.researchers.bull_researcher",
    "bear_researcher": "tradingagents.agents.researchers.bear_researcher",
    "research_manager": "tradingagents.agents.managers.research_manager",
    "trader_system": "tradingagents.agents.trader.trader",
    "trader_user": "tradingagents.agents.trader.trader",
    "aggressive_debator": "tradingagents.agents.risk_mgmt.aggressive_debator",
    "conservative_debator": "tradingagents.agents.risk_mgmt.conservative_debator",
    "neutral_debator": "tradingagents.agents.risk_mgmt.neutral_debator",
    "risk_manager": "tradingagents.agents.managers.risk_manager",
}
NODE_MODULES: tuple[str, ...] = tuple(dict.fromkeys(NODE_PROMPTS.values()))

JUDGE_PROMPT = "confidence_judge"

# Tests swap in an ``httpx.MockTransport``.
_transport: httpx.AsyncBaseTransport | None = None

_run_overrides: ContextVar[dict[str, str]] = ContextVar("agents_prompt_overrides", default={})

_upstream_load_prompt = ta_prompts.load_prompt


class PromptDefault(TypedDict):
    text: str
    placeholders: list[str]


def placeholders(template: str) -> list[str]:
    """The ``{name}`` fields of a ``str.format`` template, sorted."""
    names = {field for _, field, _, _ in string.Formatter().parse(template) if field}
    return sorted(names)


def raw_node_prompt(name: str) -> str:
    """The upstream ``.md`` text, without the language line ``load_prompt`` appends."""
    return (ta_prompts._PROMPT_DIR / f"{name}.md").read_text()


def prompt_defaults() -> dict[str, PromptDefault]:
    from .confidence import JUDGE_PROMPT_TEMPLATE

    texts = {name: raw_node_prompt(name) for name in NODE_PROMPTS}
    texts[JUDGE_PROMPT] = JUDGE_PROMPT_TEMPLATE
    return {name: {"text": text, "placeholders": placeholders(text)} for name, text in texts.items()}


def set_run_overrides(overrides: dict[str, str]) -> Token[dict[str, str]]:
    return _run_overrides.set(dict(overrides))


def reset_run_overrides(token: Token[dict[str, str]]) -> None:
    _run_overrides.reset(token)


def get_override(name: str) -> str | None:
    return _run_overrides.get().get(name)


def load_prompt_with_overrides(name: str) -> str:
    """``load_prompt`` that prefers this run's override, keeping the language line."""
    override = get_override(name)
    if override is None:
        return _upstream_load_prompt(name)
    return override + ta_prompts._language_instruction()


def install_prompt_overrides() -> None:
    """Point every node module's ``load_prompt`` at the override-aware loader.

    Idempotent. The nodes look ``load_prompt`` up in their module globals each
    time they run, so this works on graphs compiled before or after the call.
    """
    for module_name in NODE_MODULES:
        module = importlib.import_module(module_name)
        setattr(module, "load_prompt", load_prompt_with_overrides)


async def fetch_prompt_overrides() -> dict[str, str]:
    """This run's overrides from web's Settings. Any failure means defaults:
    an unreachable Settings page must never stop a run."""
    settings = get_settings()
    try:
        async with httpx.AsyncClient(transport=_transport, timeout=5) as client:
            res = await client.get(
                f"{settings.WEB_INTERNAL_BASE_URL}/api/internal/prompts",
                headers={"authorization": f"Bearer {settings.INTERNAL_BEARER}"},
            )
        res.raise_for_status()
        body = res.json()
        overrides = body.get("overrides") if isinstance(body, dict) else None
        if not isinstance(overrides, dict) or not all(
            isinstance(k, str) and isinstance(v, str) for k, v in overrides.items()
        ):
            raise ValueError(f"unexpected body: {str(body)[:200]}")
    except Exception as e:  # noqa: BLE001 - fall back to defaults, never fail the run
        logger.warning("could not read prompt overrides, using the defaults: %s", e)
        return {}
    if overrides:
        logger.info("agents run uses prompt overrides for: %s", ", ".join(sorted(overrides)))
    return overrides
