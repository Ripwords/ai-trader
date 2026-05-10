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


def build_toolkit(opend_client: OpenDClient | None) -> AgentToolkit:
    """Build the 9-tool toolkit. ``opend_client`` may be None in tests; the
    market-data tools then short-circuit with a friendly placeholder.

    All tool parameters use ``symbol`` (matching TradingAgents' bundled tool
    signatures) so the analyst prompts can call our shim without param-name
    drift; the LLM was burning ~3 tool calls per run guessing ``ticker`` vs
    ``symbol`` before this rename.
    """

    @tool
    async def get_balance_sheet(symbol: str) -> str:
        """Latest balance sheet for the given symbol."""
        data = await _internal_get("/internal/yahoo/balance-sheet", {"symbol": symbol})
        bs = data.get("balance_sheet")
        if not bs:
            return f"No balance sheet available for {symbol}."
        return f"Balance Sheet for {symbol}:\n```json\n{json.dumps(bs, indent=2)}\n```"

    @tool
    async def get_cashflow(symbol: str) -> str:
        """Latest cash-flow statement for the given symbol."""
        data = await _internal_get("/internal/yahoo/cashflow", {"symbol": symbol})
        cf = data.get("cashflow")
        if not cf:
            return f"No cashflow available for {symbol}."
        return f"Cashflow for {symbol}:\n```json\n{json.dumps(cf, indent=2)}\n```"

    @tool
    async def get_income_statement(symbol: str) -> str:
        """Latest income statement for the given symbol."""
        data = await _internal_get("/internal/yahoo/income-statement", {"symbol": symbol})
        is_ = data.get("income_statement")
        if not is_:
            return f"No income statement available for {symbol}."
        return f"Income Statement for {symbol}:\n```json\n{json.dumps(is_, indent=2)}\n```"

    @tool
    async def get_fundamentals(symbol: str) -> str:
        """Comprehensive fundamentals bundle (PE, margins, growth, etc.)."""
        data = await _internal_get("/internal/yahoo/fundamentals", {"symbol": symbol})
        return f"Fundamentals for {symbol}:\n```json\n{json.dumps(data, indent=2)}\n```"

    @tool
    async def get_insider_transactions(symbol: str) -> str:
        """Recent insider trades for the given symbol."""
        data = await _internal_get(
            "/internal/yahoo/insider-transactions", {"symbol": symbol}
        )
        rows = data.get("transactions") or []
        if not rows:
            return f"No insider transactions in the last 90 days for {symbol}."
        return f"Insider Transactions for {symbol}:\n```json\n{json.dumps(rows, indent=2)}\n```"

    @tool
    async def get_news(symbol: str, date_range: str = "7d") -> str:
        """Recent news articles mentioning the symbol."""
        data = await _internal_get(
            "/internal/news/symbol", {"symbol": symbol, "max_results": 10}
        )
        if data.get("error") and not data.get("results"):
            return "News search not configured. Skipping news analysis."
        return f"News for {symbol}:\n```json\n{json.dumps(data.get('results', []), indent=2)}\n```"

    @tool
    async def get_global_news(date_range: str = "7d", topic: str = "macro") -> str:
        """Recent global macroeconomic news headlines."""
        data = await _internal_get(
            "/internal/news/global",
            {"query": f"{topic} news", "max_results": 10},
        )
        if data.get("error") and not data.get("results"):
            return "News search not configured. Skipping global news."
        return f"Global News:\n```json\n{json.dumps(data.get('results', []), indent=2)}\n```"

    @tool
    async def get_stock_data(symbol: str, start_date: str, end_date: str) -> str:
        """Daily OHLCV bars for the given symbol in the date range."""
        if opend_client is None:
            return f"Market data unavailable for {symbol}."
        moomoo_code = _normalize_moomoo_symbol(symbol)
        bars = await _kline_bars(opend_client, moomoo_code, ktype="K_DAY", num=252)
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
            f"Daily bars for {symbol} ({start_date}..{end_date}):\n"
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
        if opend_client is None:
            return f"Market data unavailable for {symbol}."

        if isinstance(indicator, list):
            indicators = [str(s).strip() for s in indicator if str(s).strip()]
        else:
            indicators = [s.strip() for s in str(indicator).split(",") if s.strip()]
        if not indicators:
            return "No indicators requested."

        moomoo_code = _normalize_moomoo_symbol(symbol)
        # Daily bars; ``look_back_days`` plus a small buffer so multi-period
        # indicators like SMA-50 / MACD have warm-up data on the front end.
        bars = await _kline_bars(
            opend_client, moomoo_code, ktype="K_DAY", num=max(look_back_days + 60, 120)
        )
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
        return f"Indicators for {symbol} as of {curr_date} (look_back={look_back_days}d):\n{body}"

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
