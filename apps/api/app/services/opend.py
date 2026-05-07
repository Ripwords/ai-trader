from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from app.schemas.quote import Bar, KLineResponse, KLineType, Snapshot


class OpendError(RuntimeError):
    """Raised when OpenD returns a non-success result."""


_KTYPE_TO_SDK = {
    "1m": "K_1M",
    "3m": "K_3M",
    "5m": "K_5M",
    "15m": "K_15M",
    "30m": "K_30M",
    "60m": "K_60M",
    "1d": "K_DAY",
    "1w": "K_WEEK",
    "1M": "K_MON",
}


class OpendAdapter:
    """Thin synchronous wrapper around moomoo OpenQuoteContext.

    Each public method opens a context, runs the SDK call, and closes the context.
    Tests inject a `_ctx_factory` returning a fake; production resolves the real SDK.
    """

    def __init__(
        self,
        host: str,
        port: int,
        *,
        _ctx_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._ctx_factory = _ctx_factory or self._default_ctx_factory

    def _default_ctx_factory(self) -> Any:
        from moomoo import OpenQuoteContext  # type: ignore[import-not-found]
        return OpenQuoteContext(host=self._host, port=self._port)

    def get_kline(self, code: str, *, ktype: KLineType, num: int) -> KLineResponse:
        ctx = self._ctx_factory()
        try:
            # moomoo SDK enums are only resolvable when the package is installed.
            # When running under a fake ctx (tests without the SDK), the import
            # raises ImportError and we fall back to passing raw strings, which
            # FakeQuoteCtx accepts. The "moomoo" type-check guards the case where
            # the SDK *is* installed but a fake ctx is injected (full-dep test env).
            from moomoo import AuType, KLType  # type: ignore[import-not-found]
            sdk_ktype = getattr(KLType, _KTYPE_TO_SDK[ktype], None) if "moomoo" in str(type(ctx)) else _KTYPE_TO_SDK[ktype]
            ret, data = ctx.get_cur_kline(
                code,
                num=num,
                ktype=sdk_ktype if sdk_ktype is not None else _KTYPE_TO_SDK[ktype],
                autype=getattr(AuType, "QFQ", "QFQ") if "moomoo" in str(type(ctx)) else "QFQ",
            )
        except ImportError:
            ret, data = ctx.get_cur_kline(code, num=num, ktype=_KTYPE_TO_SDK[ktype], autype="QFQ")
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_cur_kline failed: {data}")
        bars = [
            Bar(
                time=datetime.fromisoformat(str(row["time_key"])),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=int(row["volume"]),
                turnover=float(row["turnover"]),
            )
            for _, row in data.iterrows()
        ]
        return KLineResponse(code=code, ktype=ktype, bars=bars)

    def get_snapshot(self, code: str) -> Snapshot:
        ctx = self._ctx_factory()
        try:
            ret, data = ctx.get_market_snapshot([code])
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_market_snapshot failed: {data}")
        if data.empty:
            raise OpendError(f"snapshot empty for {code}")
        row = data.iloc[0].to_dict()
        return Snapshot(
            code=row["code"],
            name=row.get("name") if isinstance(row.get("name"), str) else None,
            last_price=float(row["last_price"]),
            open_price=float(row["open_price"]),
            high_price=float(row["high_price"]),
            low_price=float(row["low_price"]),
            prev_close_price=float(row["prev_close_price"]),
            change_rate=float(row["change_rate"]),
            volume=int(row["volume"]),
            turnover=float(row["turnover"]),
            update_time=datetime.fromisoformat(str(row["update_time"])),
        )
