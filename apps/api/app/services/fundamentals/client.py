"""Free fundamentals client backed by yfinance.

yfinance is sync and uses requests under the hood, so each public coroutine
hops to a worker thread via asyncio.to_thread. Results are deduped through
the module-level TTL cache in `cache.py` keyed by `<fn>:<yf_symbol>:<args>`.

Symbol convention: callers pass moomoo-style codes like `US.NVDA`,
`HK.00700`, `SH.600519`, `SZ.000001`. We translate to yfinance tickers in
`_to_yf_symbol`. The yfinance ticker is what we cache by.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal, cast

from app.schemas.fundamentals import (
    FinancialMetrics,
    FundamentalsBundle,
    HistoricalPeriod,
    InsiderTrade,
    NewsItem,
)
from app.services.fundamentals.cache import (
    HISTORY_TTL_SECONDS,
    INSIDER_TTL_SECONDS,
    METRICS_TTL_SECONDS,
    NEWS_TTL_SECONDS,
    cache,
)

HistoryPeriod = Literal["annual", "quarterly"]


def _to_yf_symbol(s: str) -> str:
    """Translate moomoo-style codes to yfinance tickers.

    `US.NVDA` -> `NVDA`
    `HK.00700` -> `0700.HK` (yfinance HK tickers are 4 digits, leading zeros)
    `SH.600519` -> `600519.SS`
    `SZ.000001` -> `000001.SZ`
    Anything without a known prefix passes through unchanged.
    """
    if "." not in s:
        return s
    prefix, rest = s.split(".", 1)
    prefix = prefix.upper()
    if prefix == "US":
        return rest
    if prefix == "HK":
        digits = rest.lstrip("0") or "0"
        return f"{digits.zfill(4)}.HK"
    if prefix == "SH":
        return f"{rest}.SS"
    if prefix == "SZ":
        return f"{rest}.SZ"
    return s


def _f(value: object) -> float | None:
    """Coerce yfinance values (which may be None, NaN, np.float, str) to float|None."""
    if value is None:
        return None
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def _get_ticker(yf_symbol: str) -> Any:
    import yfinance as yf  # type: ignore[import-not-found]
    return yf.Ticker(yf_symbol)


def _fetch_metrics_sync(symbol: str, yf_symbol: str) -> FinancialMetrics:
    ticker = _get_ticker(yf_symbol)
    info_obj = getattr(ticker, "info", {}) or {}
    info: dict[str, object] = cast(dict[str, object], info_obj)
    return FinancialMetrics(
        symbol=symbol,
        market_cap=_f(info.get("marketCap")),
        pe_ratio=_f(info.get("trailingPE")),
        pb_ratio=_f(info.get("priceToBook")),
        ps_ratio=_f(info.get("priceToSalesTrailing12Months")),
        eps=_f(info.get("trailingEps")),
        dividend_yield=_f(info.get("dividendYield")),
        return_on_equity=_f(info.get("returnOnEquity")),
        return_on_assets=_f(info.get("returnOnAssets")),
        profit_margin=_f(info.get("profitMargins")),
        operating_margin=_f(info.get("operatingMargins")),
        revenue_growth=_f(info.get("revenueGrowth")),
        earnings_growth=_f(info.get("earningsGrowth")),
        debt_to_equity=_f(info.get("debtToEquity")),
        current_ratio=_f(info.get("currentRatio")),
        free_cash_flow=_f(info.get("freeCashflow")),
        beta=_f(info.get("beta")),
        shares_outstanding=_f(info.get("sharesOutstanding")),
    )


def _row_lookup(df: Any, candidates: list[str]) -> Any:
    """yfinance financial frames have inconsistent row labels across versions
    ('Total Revenue' vs 'TotalRevenue'). Try each candidate; return None if absent."""
    if df is None:
        return None
    index = getattr(df, "index", None)
    if index is None:
        return None
    try:
        labels = {str(label): label for label in index}
    except TypeError:
        return None
    for c in candidates:
        if c in labels:
            return df.loc[labels[c]]
    return None


def _column_value(row: Any, column: object) -> float | None:
    if row is None:
        return None
    try:
        return _f(row[column])
    except (KeyError, IndexError, TypeError):
        return None


def _fetch_history_sync(yf_symbol: str, period: HistoryPeriod, limit: int) -> list[HistoricalPeriod]:
    ticker = _get_ticker(yf_symbol)
    if period == "quarterly":
        income = getattr(ticker, "quarterly_financials", None)
        balance = getattr(ticker, "quarterly_balance_sheet", None)
        cashflow = getattr(ticker, "quarterly_cashflow", None)
    else:
        income = getattr(ticker, "financials", None)
        balance = getattr(ticker, "balance_sheet", None)
        cashflow = getattr(ticker, "cashflow", None)

    columns: list[object] = []
    for df in (income, balance, cashflow):
        cols = getattr(df, "columns", None)
        if cols is None:
            continue
        for c in cols:
            if c not in columns:
                columns.append(c)
    columns.sort(reverse=True)
    columns = columns[:limit]

    revenue_row = _row_lookup(income, ["Total Revenue", "TotalRevenue", "Revenue"])
    net_income_row = _row_lookup(income, ["Net Income", "NetIncome", "Net Income Common Stockholders"])
    eps_row = _row_lookup(income, ["Diluted EPS", "Basic EPS", "DilutedEPS", "BasicEPS"])
    fcf_row = _row_lookup(cashflow, ["Free Cash Flow", "FreeCashFlow"])
    debt_row = _row_lookup(balance, ["Total Debt", "TotalDebt"])
    assets_row = _row_lookup(balance, ["Total Assets", "TotalAssets"])
    equity_row = _row_lookup(
        balance,
        ["Stockholders Equity", "Total Stockholder Equity", "StockholdersEquity", "Common Stock Equity"],
    )

    out: list[HistoricalPeriod] = []
    for col in columns:
        period_label = str(col)[:10] if hasattr(col, "strftime") or "-" in str(col) else str(col)
        out.append(HistoricalPeriod(
            period=period_label,
            revenue=_column_value(revenue_row, col),
            net_income=_column_value(net_income_row, col),
            eps=_column_value(eps_row, col),
            fcf=_column_value(fcf_row, col),
            total_debt=_column_value(debt_row, col),
            total_assets=_column_value(assets_row, col),
            shareholders_equity=_column_value(equity_row, col),
        ))
    return out


def _fetch_insider_sync(yf_symbol: str, limit: int) -> list[InsiderTrade]:
    ticker = _get_ticker(yf_symbol)
    df = getattr(ticker, "insider_transactions", None)
    if df is None or getattr(df, "empty", True):
        return []
    out: list[InsiderTrade] = []
    for _, row in df.iterrows():
        r = row.to_dict()
        text = str(r.get("Text", "") or r.get("Transaction", "")).lower()
        # yfinance encodes direction in a text field; "sale" or "sell" -> sell, otherwise buy.
        tx: Literal["buy", "sell"] = "sell" if ("sale" in text or "sell" in text) else "buy"
        date_raw = r.get("Start Date") or r.get("Date") or ""
        date_str = str(date_raw)[:10]
        shares_raw = r.get("Shares", 0) or 0
        try:
            shares = int(float(shares_raw))
        except (TypeError, ValueError):
            shares = 0
        out.append(InsiderTrade(
            date=date_str,
            insider_name=str(r.get("Insider", "") or r.get("Name", "")),
            transaction_type=tx,
            shares=shares,
            value=_f(r.get("Value")),
        ))
        if len(out) >= limit:
            break
    return out


def _fetch_news_sync(yf_symbol: str, limit: int) -> list[NewsItem]:
    ticker = _get_ticker(yf_symbol)
    raw = getattr(ticker, "news", None) or []
    out: list[NewsItem] = []
    for item in raw[:limit]:
        if not isinstance(item, dict):
            continue
        # yfinance >=0.2.40 nests fields under "content"; older versions put them flat.
        content_obj = item.get("content")
        content: dict[str, object] = content_obj if isinstance(content_obj, dict) else cast(dict[str, object], item)
        title = str(content.get("title", "") or "")
        url_obj = content.get("canonicalUrl") or content.get("link") or ""
        if isinstance(url_obj, dict):
            url = str(url_obj.get("url", "") or "")
        else:
            url = str(url_obj)
        published = str(content.get("pubDate") or content.get("providerPublishTime") or "")
        if not title or not url:
            continue
        out.append(NewsItem(title=title, url=url, published_at=published, sentiment=None))
    return out


async def get_financial_metrics(symbol: str) -> FinancialMetrics:
    yf_symbol = _to_yf_symbol(symbol)
    key = f"metrics:{yf_symbol}"
    cached = cache.get(key)
    if isinstance(cached, FinancialMetrics):
        return cached
    result = await asyncio.to_thread(_fetch_metrics_sync, symbol, yf_symbol)
    cache.set(key, result, METRICS_TTL_SECONDS)
    return result


async def get_historical(
    symbol: str,
    period: HistoryPeriod = "annual",
    limit: int = 5,
) -> list[HistoricalPeriod]:
    yf_symbol = _to_yf_symbol(symbol)
    key = f"history:{yf_symbol}:{period}:{limit}"
    cached = cache.get(key)
    if isinstance(cached, list):
        return cast(list[HistoricalPeriod], cached)
    result = await asyncio.to_thread(_fetch_history_sync, yf_symbol, period, limit)
    cache.set(key, result, HISTORY_TTL_SECONDS)
    return result


async def get_insider_trades(symbol: str, limit: int = 20) -> list[InsiderTrade]:
    yf_symbol = _to_yf_symbol(symbol)
    key = f"insider:{yf_symbol}:{limit}"
    cached = cache.get(key)
    if isinstance(cached, list):
        return cast(list[InsiderTrade], cached)
    result = await asyncio.to_thread(_fetch_insider_sync, yf_symbol, limit)
    cache.set(key, result, INSIDER_TTL_SECONDS)
    return result


async def get_company_news(symbol: str, limit: int = 10) -> list[NewsItem]:
    yf_symbol = _to_yf_symbol(symbol)
    key = f"news:{yf_symbol}:{limit}"
    cached = cache.get(key)
    if isinstance(cached, list):
        return cast(list[NewsItem], cached)
    result = await asyncio.to_thread(_fetch_news_sync, yf_symbol, limit)
    cache.set(key, result, NEWS_TTL_SECONDS)
    return result


async def get_fundamentals_bundle(symbol: str) -> FundamentalsBundle:
    metrics, history = await asyncio.gather(
        get_financial_metrics(symbol),
        get_historical(symbol),
    )
    return FundamentalsBundle(metrics=metrics, history=history)
