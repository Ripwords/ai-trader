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
import math
import os
from dataclasses import dataclass
from datetime import date
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


# ─── trend formatting helpers ──────────────────────────────────────────
# Analysts pay per token; trend sections are compact markdown tables of
# pre-formatted magnitudes ("130.50B"), not raw JSON dumps.


def _fmt_money(v: Any) -> str:
    """Compact money formatting: 130_497_000_000 → ``130.50B``; None → n/a."""
    if v is None or isinstance(v, bool):
        return "n/a"
    try:
        x = float(v)
    except (TypeError, ValueError):
        return "n/a"
    if not math.isfinite(x):
        return "n/a"
    sign = "-" if x < 0 else ""
    a = abs(x)
    for div, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            return f"{sign}{a / div:.2f}{suffix}"
    return f"{sign}{a:.2f}"


def _pct_delta(curr: Any, prev: Any) -> str:
    """Signed percent change ``prev → curr`` (``+114.2%``), n/a when undefined."""
    try:
        c, p = float(curr), float(prev)
    except (TypeError, ValueError):
        return "n/a"
    if not math.isfinite(c) or not math.isfinite(p) or p == 0:
        return "n/a"
    return f"{(c - p) / abs(p) * 100:+.1f}%"


def _cagr_pct(first: Any, last: Any, years: int) -> str:
    """Compound annual growth from ``first`` to ``last`` over ``years``
    intervals. n/a when either endpoint is missing or non-positive (CAGR of
    a negative base is undefined)."""
    try:
        f0, f1 = float(first), float(last)
    except (TypeError, ValueError):
        return "n/a"
    if years <= 0 or f0 <= 0 or f1 <= 0:
        return "n/a"
    return f"{((f1 / f0) ** (1 / years) - 1) * 100:+.1f}%"


def _md_table(headers: list[str], rows: list[list[str]]) -> str:
    lines = [
        "| " + " | ".join(headers) + " |",
        "|" + "---|" * len(headers),
    ]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def _bars_needed(start: date, today: date) -> int:
    """Daily bars to fetch so history reaches back to ``start``: calendar
    days scaled to ~5 trading days/week plus a small buffer, floored at 30
    and capped at 500 (the internal route's own cap)."""
    days_back = max((today - start).days, 1)
    return min(500, max(30, math.ceil(days_back * 5 / 7) + 10))


def _csv_num(v: Any) -> str:
    if isinstance(v, bool) or v is None:
        return ""
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else f"{v:g}"
    return str(v)


async def _statement_history(ticker: str, freq: str, periods: int) -> list[dict]:
    """Fetch multi-period statement history (most-recent-first) from the web
    container. Fail-soft: an outage or missing route returns ``[]`` so the
    calling tool still serves the latest-period snapshot."""
    data = await _internal_get_safe(
        "/api/internal/yahoo/statement-history",
        {"symbol": ticker, "freq": freq, "periods": periods},
    )
    rows = data.get("periods") if isinstance(data, dict) else None
    return rows if isinstance(rows, list) else []


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
    # tool calls per run while the LLM guesses what we want. ``freq`` is now
    # honoured (annual|quarterly trend sections). ``curr_date`` is still
    # accepted but ignored: the Yahoo-backed routes have no as-of support,
    # and dropping the param would trigger schema-validation retries in
    # prompts trained on the upstream signature — each docstring says so
    # explicitly instead of pretending. Where upstream itself is
    # inconsistent (some tools use ``symbol``, others ``ticker``), match
    # upstream — don't unify; that would just re-introduce the drift.

    @tool
    async def get_balance_sheet(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve the latest balance sheet PLUS a multi-year annual trend
        table (total assets, total debt, equity, debt/equity per fiscal
        year). ``freq`` is accepted for compatibility, but balance-sheet
        history is annual-only in the data source, so the trend is always
        annual. ``curr_date`` is ignored (no as-of support)."""
        del freq, curr_date  # see docstring — annual-only history, no as-of
        data, hist = await asyncio.gather(
            _internal_get("/api/internal/yahoo/balance-sheet", {"symbol": ticker}),
            _statement_history(ticker, "annual", 5),
        )
        bs = data.get("balance_sheet")
        if not bs and not hist:
            return f"No balance sheet available for {_label(ticker)}."
        parts: list[str] = []
        if bs:
            parts.append(
                f"Balance Sheet for {_label(ticker)} (latest period):\n"
                f"```json\n{json.dumps(bs, indent=2)}\n```"
            )
        else:
            parts.append(f"Balance Sheet for {_label(ticker)}: no latest-period snapshot.")
        if hist:
            rows = []
            for p in reversed(hist):  # oldest → newest
                debt = p.get("total_debt")
                equity = p.get("shareholders_equity")
                ratio = (
                    f"{float(debt) / float(equity):.2f}"
                    if isinstance(debt, (int, float)) and isinstance(equity, (int, float)) and equity
                    else "n/a"
                )
                rows.append([
                    str(p.get("period")),
                    _fmt_money(p.get("total_assets")),
                    _fmt_money(debt),
                    _fmt_money(equity),
                    ratio,
                ])
            parts.append(
                "Annual balance-sheet trend (oldest → newest; quarterly history "
                "not available from source):\n"
                + _md_table(["FY", "Total Assets", "Total Debt", "Equity", "Debt/Equity"], rows)
            )
        return "\n\n".join(parts)

    @tool
    async def get_cashflow(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve the latest cash flow statement PLUS a multi-year annual
        free-cash-flow trend table with YoY deltas. ``freq`` is accepted for
        compatibility, but cashflow history is annual-only in the data
        source, so the trend is always annual. ``curr_date`` is ignored
        (no as-of support)."""
        del freq, curr_date  # see docstring — annual-only history, no as-of
        data, hist = await asyncio.gather(
            _internal_get("/api/internal/yahoo/cashflow", {"symbol": ticker}),
            _statement_history(ticker, "annual", 5),
        )
        cf = data.get("cashflow")
        if not cf and not hist:
            return f"No cashflow available for {_label(ticker)}."
        parts = []
        if cf:
            parts.append(
                f"Cashflow for {_label(ticker)} (latest period):\n"
                f"```json\n{json.dumps(cf, indent=2)}\n```"
            )
        else:
            parts.append(f"Cashflow for {_label(ticker)}: no latest-period snapshot.")
        if hist:
            chron = list(reversed(hist))  # oldest → newest
            rows = []
            for i, p in enumerate(chron):
                fcf = p.get("fcf")
                yoy = _pct_delta(fcf, chron[i - 1].get("fcf")) if i else "—"
                rows.append([str(p.get("period")), _fmt_money(fcf), yoy])
            parts.append(
                "Annual free-cash-flow trend (oldest → newest; quarterly history "
                "not available from source):\n"
                + _md_table(["FY", "FCF", "YoY"], rows)
            )
        return "\n\n".join(parts)

    @tool
    async def get_income_statement(
        ticker: str,
        freq: str = "quarterly",
        curr_date: str | None = None,
    ) -> str:
        """Retrieve the latest income statement PLUS a multi-period trend
        table. ``freq='quarterly'`` (default) gives the last 8 quarters
        (revenue, QoQ, net income, EPS); ``freq='annual'`` gives 5 fiscal
        years (revenue, YoY, net income, net margin). ``curr_date`` is
        ignored (no as-of support)."""
        del curr_date  # no as-of support in the data source
        quarterly = str(freq).lower().startswith("q")
        data, hist = await asyncio.gather(
            _internal_get("/api/internal/yahoo/income-statement", {"symbol": ticker}),
            _statement_history(
                ticker, "quarterly" if quarterly else "annual", 8 if quarterly else 5
            ),
        )
        is_ = data.get("income_statement")
        if not is_ and not hist:
            return f"No income statement available for {_label(ticker)}."
        parts = []
        if is_:
            parts.append(
                f"Income Statement for {_label(ticker)} (latest period):\n"
                f"```json\n{json.dumps(is_, indent=2)}\n```"
            )
        else:
            parts.append(f"Income Statement for {_label(ticker)}: no latest-period snapshot.")
        if hist:
            chron = list(reversed(hist))  # oldest → newest
            rows = []
            if quarterly:
                for i, p in enumerate(chron):
                    rev = p.get("revenue")
                    eps = p.get("eps")
                    rows.append([
                        str(p.get("period")),
                        _fmt_money(rev),
                        _pct_delta(rev, chron[i - 1].get("revenue")) if i else "—",
                        _fmt_money(p.get("net_income")),
                        f"{float(eps):.2f}" if isinstance(eps, (int, float)) else "n/a",
                    ])
                parts.append(
                    "Quarterly trend (oldest → newest):\n"
                    + _md_table(["Quarter", "Revenue", "QoQ", "Net Income", "EPS"], rows)
                )
            else:
                for i, p in enumerate(chron):
                    rev = p.get("revenue")
                    ni = p.get("net_income")
                    margin = (
                        f"{float(ni) / float(rev) * 100:.1f}%"
                        if isinstance(ni, (int, float)) and isinstance(rev, (int, float)) and rev
                        else "n/a"
                    )
                    rows.append([
                        str(p.get("period")),
                        _fmt_money(rev),
                        _pct_delta(rev, chron[i - 1].get("revenue")) if i else "—",
                        _fmt_money(ni),
                        margin,
                    ])
                parts.append(
                    "Annual trend (oldest → newest):\n"
                    + _md_table(["FY", "Revenue", "YoY", "Net Income", "Net Margin"], rows)
                )
        return "\n\n".join(parts)

    @tool
    async def get_fundamentals(ticker: str, curr_date: str) -> str:
        """Retrieve comprehensive fundamental metrics (valuation ratios,
        margins, growth, leverage) PLUS a multi-year revenue / net income /
        FCF trend table with CAGRs. ``curr_date`` is ignored (no as-of
        support in the data source)."""
        del curr_date  # no as-of support in the data source
        data = await _internal_get("/api/internal/yahoo/fundamentals", {"symbol": ticker})
        metrics = data.get("metrics") if isinstance(data, dict) else None
        history = data.get("history") if isinstance(data, dict) else None
        body = (
            f"Fundamentals for {_label(ticker)}:\n"
            f"```json\n{json.dumps(metrics if metrics else data, indent=2)}\n```"
        )
        if isinstance(history, list) and len(history) >= 2:
            chron = list(reversed(history))  # oldest → newest
            rows = [
                [
                    str(p.get("period")),
                    _fmt_money(p.get("revenue")),
                    _fmt_money(p.get("net_income")),
                    _fmt_money(p.get("fcf")),
                ]
                for p in chron
                if isinstance(p, dict)
            ]
            years = len(chron) - 1
            first, last = chron[0], chron[-1]
            cagr_line = (
                f"CAGR over {years}y — revenue: "
                f"{_cagr_pct(first.get('revenue'), last.get('revenue'), years)}, "
                f"net income: {_cagr_pct(first.get('net_income'), last.get('net_income'), years)}, "
                f"FCF: {_cagr_pct(first.get('fcf'), last.get('fcf'), years)}"
            )
            body += (
                f"\n\nAnnual trend (oldest → newest, {len(chron)} fiscal years):\n"
                + _md_table(["FY", "Revenue", "Net Income", "FCF"], rows)
                + "\n"
                + cagr_line
            )
        return body

    @tool
    async def get_insider_transactions(
        ticker: str,
        curr_date: str | None = None,
        days: int = 90,
    ) -> str:
        """Retrieve insider transactions (open-market buys/sells) within the
        trailing ``days`` window (default 90, max 365). ``curr_date`` is
        ignored — the window always ends today (no as-of support)."""
        del curr_date  # window always ends today; no as-of support
        try:
            window = int(days)
        except (TypeError, ValueError):
            window = 90
        window = max(1, min(365, window))
        data = await _internal_get(
            "/api/internal/yahoo/insider-transactions",
            {"symbol": ticker, "days": window},
        )
        rows = data.get("transactions") or []
        if not rows:
            return f"No insider transactions in the last {window} days for {_label(ticker)}."
        return (
            f"Insider Transactions for {_label(ticker)} (last {window} days):\n"
            f"```json\n{json.dumps(rows, indent=2)}\n```"
        )

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
        """OHLCV bars for the given symbol covering start_date..end_date
        (YYYY-MM-DD). History reaches back up to ~500 trading days; ranges
        spanning more than 120 bars are downsampled to weekly bars (stated
        in the output header). Invalid/missing dates fall back to the most
        recent 60 daily bars."""
        # Parse the requested window; fall back to legacy 252-fetch/last-60
        # behaviour when the dates are unusable.
        window: tuple[date, date] | None = None
        try:
            start = date.fromisoformat(str(start_date)[:10])
            end = date.fromisoformat(str(end_date)[:10])
            if start <= end:
                window = (start, end)
        except (TypeError, ValueError):
            window = None
        num = _bars_needed(window[0], date.today()) if window else 252
        bars = await _market_bars(opend_client, symbol, ktype="K_DAY", num=num)
        if not bars:
            return f"Market data unavailable for {_label(symbol)}."
        # ``time`` is a datetime object on the production Bar model; coerce
        # to ISO strings so range filtering and output are uniform.
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
        note = ""
        if window:
            lo, hi = window[0].isoformat(), window[1].isoformat()
            selected = [b for b in bars if lo <= str(b.get("time"))[:10] <= hi]
            if not selected:
                selected = bars[-60:]
                note = " — no bars inside the requested range; showing the most recent 60"
        else:
            selected = bars[-60:]
        cadence = "daily"
        if len(selected) > 120:
            # Weekly downsample: keep the last bar of each ISO week so long
            # ranges stay token-bounded. Dict preserves first-seen week order;
            # later bars in the same week overwrite the value.
            by_week: dict[tuple[int, int], dict] = {}
            for b in selected:
                d = date.fromisoformat(str(b.get("time"))[:10])
                iso = d.isocalendar()
                by_week[(iso[0], iso[1])] = b
            daily_count = len(selected)
            selected = list(by_week.values())
            cadence = "weekly"
            note = (
                f" — downsampled to weekly ({len(selected)} bars from "
                f"{daily_count} daily){note}"
            )
        cols = ("time", "open", "high", "low", "close", "volume")
        lines = [
            ",".join(_csv_num(b.get(c)) for c in cols) for b in selected
        ]
        return (
            f"{cadence.capitalize()} bars for {_label(symbol)} "
            f"({start_date}..{end_date}){note}:\n"
            "date,open,high,low,close,volume\n" + "\n".join(lines)
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
