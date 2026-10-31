"""TradingAgents toolkit shim.

The 9 LangChain ``@tool`` functions TradingAgents expects plus two
earnings-explainer tools of our own (``get_earnings_release``,
``get_earnings_surprise``), each routed through the sibling Nuxt container's
``/internal/*`` endpoints (Yahoo fundamentals and consensus, SEC EDGAR, news
search) or the in-process moomoo OpenD client (live market data + technical
indicators). Output is LLM-shaped markdown so
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
    get_earnings_release: Any
    get_earnings_surprise: Any
    get_earnings_call_transcript: Any
    get_estimate_revisions: Any


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


def _eps(v: Any) -> str:
    return f"{float(v):.2f}" if isinstance(v, (int, float)) and not isinstance(v, bool) else "n/a"


def _signed_pct(v: Any) -> str:
    return f"{float(v):+.2f}%" if isinstance(v, (int, float)) and not isinstance(v, bool) else "n/a"


def _sum_rows(rows: list[dict], key: str) -> float | None:
    vals = [r.get(key) for r in rows]
    if not vals or not all(isinstance(v, (int, float)) for v in vals):
        return None
    return float(sum(vals))


_OTHER_FCF_NOTE = (
    "Company-reported FCF in the earnings release may differ from OCF − capex: "
    "companies often net proceeds from property and equipment sales and incentives "
    "against capex, or report finance-lease variants. Quote the release's own "
    "definition next to its number."
)


def _render_cashflow_series(label: str, series: dict, levered: Any) -> str:
    """FCF = OCF − capex per labelled period, plus the other FCF figures an
    agent will meet elsewhere, each named so they are never mixed up."""
    parts = [
        f"Cash flow for {label}",
        f"Source: {series.get('source', 'unknown')}",
        f"Definition: {series.get('definition', 'FCF = OCF − capex')}",
    ]
    quarterly = [r for r in series.get("quarterly") or [] if isinstance(r, dict)]
    if quarterly:
        rows = [
            [
                str(r.get("label")),
                _fmt_money(r.get("operating_cash_flow")),
                _fmt_money(r.get("capex")),
                f"{_fmt_money(r.get('operating_cash_flow'))} − {_fmt_money(r.get('capex'))} = {_fmt_money(r.get('fcf'))}",
            ]
            for r in quarterly
        ]
        parts.append(
            "Quarterly (oldest → newest):\n"
            + _md_table(["Period", "Operating cash flow", "Capex", "FCF = OCF − Capex"], rows)
        )
    ttm = series.get("ttm")
    if isinstance(ttm, dict):
        line = (
            f"{ttm.get('label')}: OCF {_fmt_money(ttm.get('operating_cash_flow'))} − capex "
            f"{_fmt_money(ttm.get('capex'))} = FCF {_fmt_money(ttm.get('fcf'))}"
        )
        if len(quarterly) >= 8:
            prior = quarterly[-8:-4]
            p_ocf = _sum_rows(prior, "operating_cash_flow")
            p_capex = _sum_rows(prior, "capex")
            if p_ocf is not None and p_capex is not None:
                line += (
                    f"\nvs prior TTM to {prior[-1].get('period_end')}: OCF {_fmt_money(p_ocf)} "
                    f"(OCF {_pct_delta(ttm.get('operating_cash_flow'), p_ocf)}), capex {_fmt_money(p_capex)} "
                    f"(capex {_pct_delta(ttm.get('capex'), p_capex)}), FCF {_fmt_money(p_ocf - p_capex)}. "
                    "Rising OCF with falling FCF means heavier investment spend, not weaker operations."
                )
        parts.append(line)
    annual = [r for r in series.get("annual") or [] if isinstance(r, dict)]
    if annual:
        parts.append(
            "Annual:\n"
            + _md_table(
                ["Period", "Operating cash flow", "Capex", "FCF"],
                [
                    [str(r.get("label")), _fmt_money(r.get("operating_cash_flow")),
                     _fmt_money(r.get("capex")), _fmt_money(r.get("fcf"))]
                    for r in annual
                ],
            )
        )
    for note in series.get("notes") or []:
        parts.append(f"Note: {note}")
    other = ["FCF figures you may see elsewhere — not interchangeable:"]
    if isinstance(ttm, dict):
        other.append(f"- OCF − capex (this tool): {_fmt_money(ttm.get('fcf'))} ({ttm.get('label')}).")
    if isinstance(levered, dict) and levered.get("value") is not None:
        other.append(
            f"- Yahoo levered FCF: {_fmt_money(levered.get('value'))}. {levered.get('definition', '')}. "
            "Do not present it as the company's free cash flow."
        )
    other.append(f"- {_OTHER_FCF_NOTE}")
    parts.append("\n".join(other))
    urls = series.get("source_urls") or []
    if urls:
        parts.append("Source URLs:\n" + "\n".join(f"- {u}" for u in urls))
    return "\n\n".join(parts)


def build_toolkit(
    opend_client: OpenDClient | None,
    company_name: str | None = None,
) -> AgentToolkit:
    """Build the 11-tool toolkit. ``opend_client`` may be None in tests; the
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
        """Retrieve operating cash flow, capex and FCF for the last ~8
        quarters, the trailing twelve months (with the prior TTM for
        comparison) and recent fiscal years. Every row shows FCF = OCF −
        capex with its period, and the output names the other FCF figures
        you may meet (Yahoo levered FCF, company-reported FCF) so they are
        not mixed up. ``freq`` is accepted for compatibility (both views are
        always returned). ``curr_date`` is ignored (no as-of support)."""
        del freq, curr_date  # see docstring — both views returned, no as-of
        data = await _internal_get("/api/internal/yahoo/cashflow", {"symbol": ticker})
        series = data.get("series") if isinstance(data, dict) else None
        if isinstance(series, dict) and (series.get("quarterly") or series.get("ttm")):
            return _render_cashflow_series(_label(ticker), series, data.get("yahoo_levered_fcf"))
        hist = await _statement_history(ticker, "annual", 5)
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
        fcf_note = ""
        if isinstance(metrics, dict) and "free_cash_flow" in metrics:
            # Yahoo's financialData.freeCashflow is a levered estimate, not
            # OCF − capex; unlabelled it was quoted as "the" FCF (AMZN +3.22B
            # against a real TTM of about −47B).
            metrics = {
                ("yahoo_levered_fcf" if k == "free_cash_flow" else k): v for k, v in metrics.items()
            }
            fcf_note = (
                "\nNote: yahoo_levered_fcf is Yahoo's levered free cash flow estimate, "
                "not OCF − capex and not the company-reported FCF. Use get_cashflow for "
                "OCF, capex and FCF by period."
            )
        body = (
            f"Fundamentals for {_label(ticker)}:\n"
            f"```json\n{json.dumps(metrics if metrics else data, indent=2)}\n```"
            + fcf_note
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
        single name, a list, or a comma-separated string. A name stockstats
        cannot compute is reported as ``unsupported`` next to the others.
        """
        # Models also send the list as its JSON text ('["macd", "rsi"]'), so
        # brackets and quotes are stripped from each name after splitting.
        raw = indicator if isinstance(indicator, list) else str(indicator).split(",")
        indicators = [name for name in (str(s).strip(" \t\n[]\"'") for s in raw) if name]
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
            except Exception as e:  # noqa: BLE001
                # stockstats raises a bare UserWarning (among others) for a
                # name it cannot parse; the name comes from the model, so
                # report it back rather than failing the run.
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

    @tool
    async def get_earnings_release(ticker: str, curr_date: str | None = None) -> str:
        """Retrieve the company's latest earnings press release (SEC 8-K
        Item 2.02, exhibit 99.1) as text: headline results, segment
        figures, management commentary, guidance and cash-flow tables, with
        the SEC source URLs. US SEC filers only. Use it to explain WHY
        revenue, EPS, margins or FCF moved (one-offs, FX, timing, capex,
        segment mix) and to quote management guidance. ``curr_date`` is
        ignored (always the latest release)."""
        del curr_date  # always the latest filed release
        try:
            r = await _internal_get("/api/internal/sec/earnings-release", {"symbol": ticker})
        except Exception as exc:  # noqa: BLE001 - tool output, not a crash
            return f"Earnings release unavailable for {_label(ticker)} (SEC EDGAR request failed: {exc})."
        if not isinstance(r, dict) or r.get("status") != "ok":
            reason = r.get("reason", "no release found") if isinstance(r, dict) else "no release found"
            src = f" Checked: {r.get('source_url')}." if isinstance(r, dict) and r.get("source_url") else ""
            return (
                f"No SEC earnings release for {_label(ticker)}: {reason}.{src} "
                "Use get_earnings_surprise for consensus vs actual and get_news for coverage of the results."
            )
        header = [
            f"Earnings release for {_label(ticker)}: {r.get('company')} {r.get('form')} Item 2.02, exhibit 99.1",
            f"Filed: {r.get('filing_date')} (accession {r.get('accession')})",
            f"Source: {r.get('exhibit_url')}",
            f"Filing index: {r.get('filing_index_url')}",
        ]
        if r.get("truncated"):
            omitted = ", ".join(r.get("omitted") or []) or "none"
            header.append(
                f"Text shortened from {r.get('chars_total')} characters to fit; sections left out: {omitted}. "
                "Headline results, guidance, segment and cash-flow sections are kept first."
            )
        return "\n".join(header) + "\n\n---\n" + str(r.get("text", ""))

    @tool
    async def get_earnings_surprise(ticker: str, curr_date: str | None = None) -> str:
        """Retrieve consensus vs actual EPS (with surprise %) for the last
        four reported quarters, reported revenue, and the analyst consensus
        for the next quarter and current fiscal year (EPS and revenue ranges,
        analyst count, estimate revisions). Source: Yahoo Finance consensus.
        Use it to judge a print against expectations rather than in
        isolation. ``curr_date`` is ignored (latest data)."""
        del curr_date  # latest consensus only
        try:
            s = await _internal_get("/api/internal/yahoo/earnings-surprise", {"symbol": ticker})
        except Exception as exc:  # noqa: BLE001 - tool output, not a crash
            return f"Earnings surprise data unavailable for {_label(ticker)} ({exc})."
        quarters = [q for q in (s.get("quarters") or []) if isinstance(q, dict)]
        parts = [f"Earnings surprise for {_label(ticker)}", f"Source: {s.get('source', 'Yahoo Finance consensus')}"]
        if quarters:
            rows = [
                [
                    str(q.get("fiscal_quarter")),
                    str(q.get("reported_date") or "n/a"),
                    _eps(q.get("eps_estimate")),
                    _eps(q.get("eps_actual")),
                    _signed_pct(q.get("eps_surprise_pct")),
                    _fmt_money(q.get("revenue_actual")),
                ]
                for q in quarters
            ]
            parts.append(
                "Reported quarters (oldest → newest):\n"
                + _md_table(["Quarter", "Reported", "EPS est", "EPS actual", "Surprise", "Revenue actual"], rows)
            )
            last = quarters[-1]
            if isinstance(last.get("days_since_report"), int):
                parts.append(f"Latest: {last.get('fiscal_quarter')} reported {last['days_since_report']} days ago.")
        else:
            parts.append("No reported-quarter consensus history available.")

        def _consensus(title: str, c: Any) -> str | None:
            if not isinstance(c, dict):
                return None
            line = (
                f"{title} (period ending {c.get('period_end')}, {c.get('analysts') or 'n/a'} analysts): "
                f"EPS {_eps(c.get('eps_avg'))} (range {_eps(c.get('eps_low'))}–{_eps(c.get('eps_high'))}; "
                f"year-ago {_eps(c.get('year_ago_eps'))}); revenue {_fmt_money(c.get('revenue_avg'))} "
                f"(range {_fmt_money(c.get('revenue_low'))}–{_fmt_money(c.get('revenue_high'))}; "
                f"year-ago {_fmt_money(c.get('year_ago_revenue'))}"
            )
            g = c.get("revenue_growth")
            line += f", growth {float(g) * 100:+.1f}%)." if isinstance(g, (int, float)) else ")."
            t = c.get("eps_trend")
            if isinstance(t, dict) and t.get("current") is not None:
                line += f" EPS estimate now {_eps(t.get('current'))} vs {_eps(t.get('d90'))} 90 days ago."
            rv = c.get("revisions")
            if isinstance(rv, dict):
                line += f" Revisions last 30 days: {rv.get('up_30d') or 0} up / {rv.get('down_30d') or 0} down."
            return line

        for title, key in (("Next quarter consensus", "next_quarter"), ("Current fiscal year consensus", "current_year")):
            line = _consensus(title, s.get(key))
            if line:
                parts.append(line)
        if s.get("next_earnings_date"):
            parts.append(f"Next earnings date: {s['next_earnings_date']}.")
        notes = s.get("notes") or []
        if notes:
            parts.append("Notes:\n" + "\n".join(f"- {n}" for n in notes))
        return "\n\n".join(parts)

    def _av_quota_line(r: dict) -> str:
        q = r.get("quota") if isinstance(r.get("quota"), dict) else {}
        cached = " (cached, no request spent)" if r.get("cached") else ""
        return f"Alpha Vantage requests left today: {q.get('remaining', 'n/a')} of {q.get('limit', 25)}{cached}."

    def _av_unavailable(what: str, ticker: str, r: dict, fallback: str) -> str:
        reason = r.get("reason")
        msg = r.get("message") or "no reason given"
        if reason in ("quota_exhausted", "no_key"):
            return (
                f"{what} unavailable for {_label(ticker)}: Alpha Vantage quota is used up or not configured ({msg}). "
                f"Do not call this tool again in this run; use {fallback} instead."
            )
        return f"{what} unavailable for {_label(ticker)} ({msg}). Use {fallback} instead."

    @tool
    async def get_earnings_call_transcript(ticker: str, quarter: str | None = None) -> str:
        """Retrieve the latest earnings-call transcript: management's
        prepared remarks and the analyst Q&A, with a sentiment score per
        turn. Use it for WHY a number moved in management's own words, what
        analysts pressed on, and what management avoided answering. Pass
        ``quarter`` as YYYYQn (e.g. 2026Q2) for a specific call; omit it for
        the latest published one. Limited free budget: call it at most once
        per run."""
        params = {"symbol": ticker}
        if quarter:
            params["quarter"] = quarter
        try:
            r = await _internal_get("/api/internal/alpha-vantage/transcript", params)
        except Exception as exc:  # noqa: BLE001 - tool output, not a crash
            return f"Earnings-call transcript unavailable for {_label(ticker)} ({exc}). Use get_earnings_release instead."
        if r.get("status") != "ok":
            return _av_unavailable("Earnings-call transcript", ticker, r, "get_earnings_release and get_news")
        d = r.get("data") or {}

        def _turns(turns: Any) -> str:
            out = []
            for t in turns or []:
                if not isinstance(t, dict):
                    continue
                s = t.get("sentiment")
                senti = f", sentiment {float(s):+.2f}" if isinstance(s, (int, float)) else ""
                body = str(t.get("content", ""))
                if t.get("truncated"):
                    body += " [turn truncated]"
                out.append(f"**{t.get('speaker')} ({t.get('title')}{senti})**: {body}")
            return "\n\n".join(out)

        parts = [
            f"Earnings-call transcript for {_label(ticker)}, {d.get('quarter')}",
            f"Source: {r.get('source', 'Alpha Vantage')}. {_av_quota_line(r)}",
        ]
        for n in d.get("notes") or []:
            parts.append(f"Note: {n}")
        parts.append("## Prepared remarks\n" + (_turns(d.get("prepared")) or "(none)"))
        parts.append("## Q&A\n" + (_turns(d.get("qa")) or "(no Q&A section found)"))
        return "\n\n".join(parts)

    @tool
    async def get_estimate_revisions(ticker: str, curr_date: str | None = None) -> str:
        """Retrieve how analyst consensus has moved: EPS and revenue
        consensus for upcoming quarters and fiscal years, with the EPS
        estimate 90 days ago and up/down revisions over 30 days, plus the
        consensus going into each of the last four reported quarters
        (including revenue consensus, so a revenue beat or miss can be
        judged). Rising numbers into a print set a higher bar; cuts after
        a print show what the street believes. ``curr_date`` is ignored."""
        del curr_date  # latest consensus only
        try:
            r = await _internal_get("/api/internal/alpha-vantage/estimates", {"symbol": ticker})
        except Exception as exc:  # noqa: BLE001 - tool output, not a crash
            return f"Estimate revisions unavailable for {_label(ticker)} ({exc}). Use get_earnings_surprise instead."
        if r.get("status") != "ok":
            return _av_unavailable("Estimate revisions", ticker, r, "get_earnings_surprise")
        d = r.get("data") or {}
        parts = [
            f"Estimate revisions for {_label(ticker)}",
            f"Source: {r.get('source', 'Alpha Vantage')}. {_av_quota_line(r)}",
        ]
        fwd = [p for p in d.get("forward") or [] if isinstance(p, dict)]
        if fwd:
            rows = []
            for p in fwd:
                rv = p.get("revisions_30d") or {}
                rows.append([
                    f"{p.get('horizon')} {p.get('date')}",
                    _eps(p.get("eps_avg")),
                    _eps(p.get("eps_90d_ago")),
                    _signed_pct(p.get("eps_change_90d_pct")),
                    f"{rv.get('up') or 0:g} / {rv.get('down') or 0:g}",
                    _fmt_money(p.get("revenue_avg")),
                    f"{p.get('eps_analysts'):g}" if isinstance(p.get("eps_analysts"), (int, float)) else "n/a",
                ])
            parts.append(
                "Forward consensus (period end):\n"
                + _md_table(["Period", "EPS now", "EPS 90d ago", "90d change", "Revisions 30d up / down", "Revenue", "Analysts"], rows)
            )
        rep = [p for p in d.get("reported") or [] if isinstance(p, dict)]
        if rep:
            rows = [[str(p.get("date")), _eps(p.get("eps_avg")), _fmt_money(p.get("revenue_avg"))] for p in rep]
            parts.append(
                "Consensus going into recent prints (compare with reported actuals):\n"
                + _md_table(["Quarter end", "EPS consensus", "Revenue consensus"], rows)
            )
        return "\n\n".join(parts)

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
        get_earnings_release=get_earnings_release,
        get_earnings_surprise=get_earnings_surprise,
        get_earnings_call_transcript=get_earnings_call_transcript,
        get_estimate_revisions=get_estimate_revisions,
    )
