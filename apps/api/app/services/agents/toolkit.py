"""TradingAgents toolkit shim.

The 8 LangChain ``@tool`` functions TradingAgents expects, each routed
through the sibling Nuxt container's ``/internal/*`` endpoints (Yahoo
fundamentals, news search) or the in-process moomoo OpenD client (live
market data + technical indicators). Output is LLM-shaped markdown so
agents can quote it back in their analysis.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
import pandas as pd
import stockstats
from langchain_core.tools import tool


class OpenDClient(Protocol):
    """Subset of the moomoo OpenD client the toolkit relies on."""

    async def get_kline(self, ticker: str, ktype: str, num: int) -> list[dict]: ...
    async def get_snapshot(self, ticker: str) -> dict | None: ...


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


def build_toolkit(opend_client: OpenDClient | None) -> AgentToolkit:
    """Build the 9-tool toolkit. ``opend_client`` may be None in tests; the
    market-data tools then short-circuit with a friendly placeholder."""

    @tool
    async def get_balance_sheet(ticker: str) -> str:
        """Latest balance sheet for the given ticker."""
        data = await _internal_get("/internal/yahoo/balance-sheet", {"symbol": ticker})
        bs = data.get("balance_sheet")
        if not bs:
            return f"No balance sheet available for {ticker}."
        return f"Balance Sheet for {ticker}:\n```json\n{json.dumps(bs, indent=2)}\n```"

    @tool
    async def get_cashflow(ticker: str) -> str:
        """Latest cash-flow statement for the given ticker."""
        data = await _internal_get("/internal/yahoo/cashflow", {"symbol": ticker})
        cf = data.get("cashflow")
        if not cf:
            return f"No cashflow available for {ticker}."
        return f"Cashflow for {ticker}:\n```json\n{json.dumps(cf, indent=2)}\n```"

    @tool
    async def get_income_statement(ticker: str) -> str:
        """Latest income statement for the given ticker."""
        data = await _internal_get("/internal/yahoo/income-statement", {"symbol": ticker})
        is_ = data.get("income_statement")
        if not is_:
            return f"No income statement available for {ticker}."
        return f"Income Statement for {ticker}:\n```json\n{json.dumps(is_, indent=2)}\n```"

    @tool
    async def get_fundamentals(ticker: str) -> str:
        """Comprehensive fundamentals bundle (PE, margins, growth, etc.)."""
        data = await _internal_get("/internal/yahoo/fundamentals", {"symbol": ticker})
        return f"Fundamentals for {ticker}:\n```json\n{json.dumps(data, indent=2)}\n```"

    @tool
    async def get_insider_transactions(ticker: str) -> str:
        """Recent insider trades for the given ticker."""
        data = await _internal_get(
            "/internal/yahoo/insider-transactions", {"symbol": ticker}
        )
        rows = data.get("transactions") or []
        if not rows:
            return f"No insider transactions in the last 90 days for {ticker}."
        return f"Insider Transactions for {ticker}:\n```json\n{json.dumps(rows, indent=2)}\n```"

    @tool
    async def get_news(ticker: str, date_range: str = "7d") -> str:
        """Recent news articles mentioning the ticker."""
        data = await _internal_get(
            "/internal/news/symbol", {"symbol": ticker, "max_results": 10}
        )
        if data.get("error") and not data.get("results"):
            return "News search not configured. Skipping news analysis."
        return f"News for {ticker}:\n```json\n{json.dumps(data.get('results', []), indent=2)}\n```"

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
    async def get_stock_data(ticker: str, start_date: str, end_date: str) -> str:
        """Daily OHLCV bars for the given ticker in the date range."""
        if opend_client is None:
            return f"Market data unavailable for {ticker}."
        bars = await opend_client.get_kline(ticker, ktype="K_DAY", num=252)
        return (
            f"Daily bars for {ticker} ({start_date}..{end_date}):\n"
            f"```json\n{json.dumps(bars[-60:], indent=2)}\n```"
        )

    @tool
    async def get_indicators(ticker: str, indicator: str, date: str) -> str:
        """Technical indicator value (rsi/macd/etc.) for the given ticker on the given date."""
        if opend_client is None:
            return f"Market data unavailable for {ticker}."
        bars = await opend_client.get_kline(ticker, ktype="K_DAY", num=252)
        df = pd.DataFrame(bars).rename(
            columns={
                "open": "open",
                "high": "high",
                "low": "low",
                "close": "close",
                "volume": "volume",
            }
        )
        sdf = stockstats.StockDataFrame.retype(df)
        try:
            value = float(sdf[indicator].iloc[-1])
        except KeyError:
            return f"Indicator {indicator!r} not supported."
        return f"{indicator.upper()} for {ticker} on {date}: {value:.4f}"

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
