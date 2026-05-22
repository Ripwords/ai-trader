"""TradingAgents toolkit shim.

The 8 LangChain ``@tool`` functions TradingAgents expects, each routed
through the sibling Nuxt container's ``/internal/*`` endpoints (Yahoo
fundamentals, news search) or the in-process moomoo OpenD client (live
market data + technical indicators). Output is LLM-shaped markdown so
agents can quote it back in their analysis.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
import pandas as pd
import stockstats
from langchain_core.tools import tool


class OpenDClient(Protocol):
    """Subset of the moomoo OpenD client the toolkit relies on.

    Both shapes are accepted by :func:`_kline_bars`: async (e.g. a future
    HTTP-backed wrapper) and sync (the current :class:`OpendAdapter`, which
    wraps the blocking moomoo OpenQuoteContext). Sync calls are routed
    through :func:`asyncio.to_thread` so the event loop stays responsive.
    """

    def get_kline(self, ticker: str, ktype: str, num: int) -> Any: ...


async def _kline_bars(
    opend: Any, ticker: str, *, ktype: str, num: int
) -> list[dict]:
    """Call ``opend.get_kline`` (sync or async) and return a list of bar dicts.

    Production's :class:`OpendAdapter.get_kline` is sync and returns a
    :class:`KLineResponse` pydantic model whose ``.bars`` is a list of
    :class:`Bar` models. Tests mock the call with :class:`AsyncMock` and
    return raw list-of-dict. We accommodate both: we await coroutine
    callables, run sync callables via :func:`asyncio.to_thread`, then
    coerce a :class:`KLineResponse`-shaped result to a list of dicts.
    """
    fn = getattr(opend, "get_kline", None)
    if inspect.iscoroutinefunction(fn):
        result = await opend.get_kline(ticker, ktype=ktype, num=num)
    else:
        result = await asyncio.to_thread(opend.get_kline, ticker, ktype=ktype, num=num)
    if isinstance(result, list):
        return result
    bars = getattr(result, "bars", None)
    if bars is None:
        return []
    return [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in bars]


async def _internal_get(path: str, params: dict[str, Any]) -> dict:
    base = os.environ["WEB_INTERNAL_BASE_URL"]
    bearer = os.environ["INTERNAL_BEARER"]
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{base}{path}",
            headers={"authorization": f"Bearer {bearer}"},
            params=params,
        )
        r.raise_for_status()
        return r.json()


async def _internal_get_safe(path: str, params: dict[str, Any]) -> dict:
    try:
        return await _internal_get(path, params)
    except Exception:  # noqa: BLE001 - data-source fallback should fail soft
        return {}


async def resolve_symbol(symbol: str) -> dict:
    """Resolve ``symbol`` via the web's single-source-of-truth resolver and
    return the full verdict dict (``status`` ∈ resolved/ambiguous/not_found/
    error). A resolver outage maps to ``{"status": "error"}`` so callers
    decide how strict to be (the agents fail soft; algo create fails closed).
    See docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
    """
    try:
        return await _internal_get("/api/internal/symbol/resolve", {"q": symbol})
    except Exception:  # noqa: BLE001 — resolver outage is a status, not a crash
        return {"status": "error"}


async def resolve_company_name(symbol: str) -> str | None:
    """Resolve ``symbol`` to its canonical company name via the web's
    single-source-of-truth resolver. Used as the API-side fallback when a
    caller hit ``/agents/run`` directly without a pre-resolved name (the Nuxt
    proxy resolves first; direct callers don't). Returns ``None`` on
    ambiguous/not-found/error so the run still proceeds ticker-only rather
    than crashing — fail soft here, the Nuxt hard gate is the strict path.
    See docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
    """
    data = await resolve_symbol(symbol)
    if data.get("status") == "resolved":
        return data.get("name") or None
    return None


@dataclass
class AgentToolkit:
    get_stock_data: Any
    get_indicators: Any
    get_fundamentals: Any
    get_balance_sheet: Any
    get_cashflow: Any
    get_income_statement: Any
    get_insider_transactions: Any
    get_news: Any
    get_global_news: Any


def _normalize_moomoo_symbol(symbol: str) -> str:
    """Coerce a bare ticker (``SOFI``) into moomoo's ``US.SOFI`` format.

    moomoo's quote API rejects bare tickers with::

        ERROR. format of code SOFI is wrong. (US.AAPL, HK.00700, SZ.000001)

    Analysts often emit the bare form because the prompt context (a US
    stock symbol) gives them no reason to add a market prefix. If a prefix
    is already present (any ``.`` in the string), pass through untouched
    so non-US tickers reach moomoo intact.
    """
    return symbol if "." in symbol else f"US.{symbol}"


def _is_moomoo_supported_symbol(symbol: str) -> bool:
    upper = symbol.upper()
    if "." not in upper:
        return True
    return upper.startswith(("US.", "HK.", "SH.", "SZ."))


async def _yahoo_daily_bars(symbol: str, num: int) -> list[dict]:
    data = await _internal_get_safe(
        "/api/internal/yahoo/daily-bars",
        {"symbol": symbol, "limit": num},
    )
    rows = data.get("bars") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else []


async def _market_bars(opend: Any, symbol: str, *, ktype: str, num: int) -> list[dict]:
    if opend is not None and _is_moomoo_supported_symbol(symbol):
        try:
            return await _kline_bars(
                opend, _normalize_moomoo_symbol(symbol), ktype=ktype, num=num
            )
        except Exception:  # noqa: BLE001 - fall through to Yahoo bars
            pass
    return await _yahoo_daily_bars(symbol, num)


def build_toolkit(
    opend_client: OpenDClient | None,
    company_name: str | None = None,
) -> AgentToolkit:
    """Build the 9-tool toolkit. ``opend_client`` may be None in tests; the
    market-data tools then short-circuit with a friendly placeholder.

    All tool parameters use ``symbol`` (matching TradingAgents' bundled tool
    signatures) so the analyst prompts can call our shim without param-name
    drift; the LLM was burning ~3 tool calls per run guessing ``ticker`` vs
    ``symbol`` before this rename.

    ``company_name`` (optional) — the Yahoo-resolved company for this run. When
    set, every tool output is labelled with it and the news query is anchored
    on it, so the analysts (and the search provider) can't drift to a
    different company sharing the ticker (the "US.MU" → "Munich Re" bug). See
    docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
    """

    def _label(ticker: str) -> str:
        """Human label for tool output: ``Micron Technology, Inc. (US.MU)``
        when resolved, else the bare ticker (legacy/direct callers)."""
        return f"{company_name} ({ticker})" if company_name else ticker

    # ─── Tool signatures match TradingAgents' bundled tools verbatim ───
    # The analyst prompts are trained on the upstream signatures; any drift
    # (param name, missing optional arg, missing date kwarg) burns multiple
    # tool calls per run while the LLM guesses what we want. We accept every
    # upstream param even when our HTTP-backed implementation can't honour
    # it (e.g. ``freq=quarterly``, ``curr_date``) — silently ignore is
    # better than schema-validation failures that the LLM has to retry past.
    # Where upstream itself is inconsistent (some tools use ``symbol``,
    # others ``ticker``), match upstream — don't unify; that would just
    # re-introduce the drift.

    @tool
    async def get_balance_sheet(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve balance sheet data for a given ticker symbol."""
        del freq, curr_date  # Yahoo bundle only carries the most-recent period
        data = await _internal_get("/api/internal/yahoo/balance-sheet", {"symbol": ticker})
        bs = data.get("balance_sheet")
        if not bs:
            return f"No balance sheet available for {_label(ticker)}."
        return f"Balance Sheet for {_label(ticker)}:\n```json\n{json.dumps(bs, indent=2)}\n```"

    @tool
    async def get_cashflow(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve cash flow statement data for a given ticker symbol."""
        del freq, curr_date
        data = await _internal_get("/api/internal/yahoo/cashflow", {"symbol": ticker})
        cf = data.get("cashflow")
        if not cf:
            return f"No cashflow available for {_label(ticker)}."
        return f"Cashflow for {_label(ticker)}:\n```json\n{json.dumps(cf, indent=2)}\n```"

    @tool
    async def get_income_statement(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve income statement data for a given ticker symbol."""
        del freq, curr_date
        data = await _internal_get("/api/internal/yahoo/income-statement", {"symbol": ticker})
        is_ = data.get("income_statement")
        if not is_:
            return f"No income statement available for {_label(ticker)}."
        return f"Income Statement for {_label(ticker)}:\n```json\n{json.dumps(is_, indent=2)}\n```"

    @tool
    async def get_fundamentals(ticker: str, curr_date: str) -> str:
        """Retrieve comprehensive fundamental data for a given ticker symbol."""
        del curr_date
        data = await _internal_get("/api/internal/yahoo/fundamentals", {"symbol": ticker})
        return f"Fundamentals for {_label(ticker)}:\n```json\n{json.dumps(data, indent=2)}\n```"

    @tool
    async def get_insider_transactions(
        ticker: str,
        curr_date: str | None = None,
    ) -> str:
        """Retrieve insider transaction information about a company."""
        del curr_date
        data = await _internal_get(
            "/api/internal/yahoo/insider-transactions", {"symbol": ticker}
        )
        rows = data.get("transactions") or []
        if not rows:
            return f"No insider transactions in the last 90 days for {_label(ticker)}."
        return f"Insider Transactions for {_label(ticker)}:\n```json\n{json.dumps(rows, indent=2)}\n```"

    @tool
    async def get_news(ticker: str, start_date: str, end_date: str) -> str:
        """Retrieve news for a ticker PLUS the macro, sector, and peer news
        that explains why it moved (rates/Fed, market-wide moves,
        competitors, geopolitics)."""
        del start_date, end_date  # search returns recent news regardless
        params: dict[str, Any] = {"symbol": ticker, "max_results": 10}
        if company_name:
            params["company"] = company_name
        data = await _internal_get("/api/internal/news/contextual", params)
        error_msg = data.get("error")
        if error_msg and not (
            data.get("ticker") or data.get("macro") or data.get("contextual")
        ):
            return "News search not configured. Skipping news analysis."

        def _section(title: str, items: list[dict]) -> str:
            if not items:
                return ""
            return f"### {title}\n```json\n{json.dumps(items, indent=2)}\n```\n"

        body = (
            _section("Ticker", data.get("ticker", []))
            + _section("Macro", data.get("macro", []))
            + _section("Sector & Peers", data.get("contextual", []))
        ) or "No news found."
        if error_msg:
            body += f"\n_(Note: news retrieval partially failed — {error_msg})_"
        return f"News for {_label(ticker)}:\n{body}"

    @tool
    async def get_global_news(
        curr_date: str,
        look_back_days: int = 7,
        limit: int = 5,
    ) -> str:
        """Retrieve global macroeconomic news headlines."""
        del curr_date, look_back_days  # search provider returns recent matches
        data = await _internal_get(
            "/api/internal/news/global",
            {"query": "global macroeconomic news", "max_results": max(limit, 5)},
        )
        if data.get("error") and not data.get("results"):
            return "News search not configured. Skipping global news."
        return f"Global News:\n```json\n{json.dumps(data.get('results', []), indent=2)}\n```"

    @tool
    async def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
        """Daily OHLCV bars for the given symbol in the date range."""
        bars = await _market_bars(opend_client, symbol, ktype="K_DAY", num=252)
        if not bars:
            return f"Market data unavailable for {_label(symbol)}."
        # ``time_key`` is a datetime object on the production Bar model; the
        # JSON encoder doesn't know how to serialise it, so coerce to ISO
        # strings before dumping.
        bars = [
            {
                **b,
                "time": (
                    b["time"].isoformat()
                    if hasattr(b.get("time"), "isoformat")
                    else b.get("time")
                ),
            }
            if "time" in b and hasattr(b.get("time"), "isoformat")
            else b
            for b in bars
        ]
        return (
            f"Daily bars for {_label(symbol)} ({start_date}..{end_date}):\n"
            f"```json\n{json.dumps(bars[-60:], indent=2, default=str)}\n```"
        )

    @tool
    async def get_indicators(
        symbol: str,
        indicator: str | list[str],
        curr_date: str,
        look_back_days: int = 30,
    ) -> str:
        """Compute one or more technical indicators (RSI, MACD, BBANDS, …)
        for the given symbol over the trailing ``look_back_days`` window.

        Mirrors TradingAgents' bundled ``get_indicators`` signature so analyst
        prompts that request multiple indicators in one call (``"macd,rsi"``
        or ``["macd", "rsi"]``) hit the right path. ``indicator`` accepts a
        single name, a list, or a comma-separated string.
        """
        if isinstance(indicator, list):
            indicators = [str(s).strip() for s in indicator if str(s).strip()]
        else:
            indicators = [s.strip() for s in str(indicator).split(",") if s.strip()]
        if not indicators:
            return "No indicators requested."

        # Daily bars; ``look_back_days`` plus a small buffer so multi-period
        # indicators like SMA-50 / MACD have warm-up data on the front end.
        bars = await _market_bars(
            opend_client, symbol, ktype="K_DAY", num=max(look_back_days + 60, 120)
        )
        if not bars:
            return f"Market data unavailable for {_label(symbol)}."
        df = pd.DataFrame(bars)
        sdf = stockstats.StockDataFrame.retype(df)

        sections: list[str] = []
        for ind in indicators:
            try:
                series = sdf[ind]
            except (KeyError, ValueError) as e:
                sections.append(f"{ind.upper()}: unsupported ({e})")
                continue
            if isinstance(series, pd.Series):
                latest = series.iloc[-1]
                try:
                    val = f"{float(latest):.4f}"
                except (TypeError, ValueError):
                    val = str(latest)
                sections.append(f"{ind.upper()}: {val}")
            elif isinstance(series, pd.DataFrame):
                # Some indicators (boll → boll, boll_ub, boll_lb) are
                # multi-column. Render every column on its own line.
                row = series.iloc[-1]
                lines = [
                    f"{ind.upper()}.{col}: "
                    + (f"{float(row[col]):.4f}" if pd.notna(row[col]) else "n/a")
                    for col in series.columns
                ]
                sections.append("\n".join(lines))
            else:
                sections.append(f"{ind.upper()}: {series}")
        body = "\n".join(sections)
        return f"Indicators for {_label(symbol)} as of {curr_date} (look_back={look_back_days}d):\n{body}"

    return AgentToolkit(
        get_stock_data=get_stock_data,
        get_indicators=get_indicators,
        get_fundamentals=get_fundamentals,
        get_balance_sheet=get_balance_sheet,
        get_cashflow=get_cashflow,
        get_income_statement=get_income_statement,
        get_insider_transactions=get_insider_transactions,
        get_news=get_news,
        get_global_news=get_global_news,
    )
