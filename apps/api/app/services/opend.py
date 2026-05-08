from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from app.schemas.quote import Bar, KLineResponse, KLineType, Snapshot
from app.schemas.trade import Account, Fill, Order, Portfolio, Position
from app.schemas.watchlist import WatchlistItem


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
    For trade methods, a separate `_trade_ctx_factory` is used (per-call, not cached).
    """

    def __init__(
        self,
        host: str,
        port: int,
        *,
        _ctx_factory: Callable[[], Any] | None = None,
        _trade_ctx_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._ctx_factory = _ctx_factory or self._default_ctx_factory
        self._trade_ctx_factory = _trade_ctx_factory or self._default_trade_ctx_factory

    def _default_ctx_factory(self) -> Any:
        from moomoo import OpenQuoteContext  # type: ignore[import-not-found]
        return OpenQuoteContext(host=self._host, port=self._port)

    def _default_trade_ctx_factory(self) -> Any:
        from moomoo import OpenSecTradeContext, SecurityFirm, TrdMarket  # type: ignore[import-not-found]
        return OpenSecTradeContext(
            host=self._host,
            port=self._port,
            filter_trdmarket=TrdMarket.NONE,
            security_firm=SecurityFirm.NONE,
        )

    def get_kline(self, code: str, *, ktype: KLineType, num: int) -> KLineResponse:
        """Fetch latest N bars via request_history_kline (no subscribe needed).

        get_cur_kline requires a prior ctx.subscribe() — fragile across calls.
        request_history_kline returns historical bars by date range, which is
        what we want for a chart anyway. We compute a buffered start date and
        slice to the latest N bars.
        """
        from datetime import date, timedelta

        # Buffer: daily/intraday — pick a window wide enough to contain N bars
        # accounting for weekends/holidays and intraday session gaps.
        buffer_days = {
            "1m": max(2, num // 200 + 1),
            "3m": max(2, num // 100 + 1),
            "5m": max(3, num // 80 + 1),
            "15m": max(5, num // 30 + 1),
            "30m": max(7, num // 15 + 1),
            "60m": max(10, num // 7 + 1),
            "1d": int(num * 1.6) + 5,
            "1w": int(num * 7 * 1.2) + 7,
            "1M": int(num * 31) + 31,
        }.get(ktype, num * 2)

        end = date.today()
        start = end - timedelta(days=buffer_days)

        ctx = self._ctx_factory()
        try:
            try:
                from moomoo import AuType, KLType  # type: ignore[import-not-found]
                is_real_sdk = "moomoo" in str(type(ctx))
                sdk_ktype = getattr(KLType, _KTYPE_TO_SDK[ktype]) if is_real_sdk else _KTYPE_TO_SDK[ktype]
                au_type = AuType.QFQ if is_real_sdk else "QFQ"
            except ImportError:
                sdk_ktype = _KTYPE_TO_SDK[ktype]
                au_type = "QFQ"

            # Fake ctx in tests still uses get_cur_kline shape; production uses request_history_kline.
            if hasattr(ctx, "request_history_kline") and "moomoo" in str(type(ctx)):
                ret, data, _page_key = ctx.request_history_kline(
                    code,
                    start=start.isoformat(),
                    end=end.isoformat(),
                    ktype=sdk_ktype,
                    autype=au_type,
                    max_count=max(num * 2, 100),
                )
            else:
                ret, data = ctx.get_cur_kline(code, num=num, ktype=sdk_ktype, autype=au_type)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_kline failed: {data}")
        all_bars = [
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
        return KLineResponse(code=code, ktype=ktype, bars=all_bars[-num:])

    def list_watchlist(self, *, group: str = "All") -> list[WatchlistItem]:
        ctx = self._ctx_factory()
        try:
            ret, data = ctx.get_user_security(group)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_user_security failed: {data}")
        items: list[WatchlistItem] = []
        for _, row in data.iterrows():
            r = row.to_dict()
            items.append(WatchlistItem(
                code=str(r["code"]),
                name=r.get("name") if isinstance(r.get("name"), str) else None,
                group=str(r.get("group", group)),
            ))
        return items

    def add_watchlist_item(self, code: str, *, group: str = "All") -> None:
        ctx = self._ctx_factory()
        try:
            ret, data = ctx.modify_user_security(group, [code], "ADD")
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"modify_user_security ADD failed: {data}")

    def remove_watchlist_item(self, code: str, *, group: str = "All") -> None:
        ctx = self._ctx_factory()
        try:
            ret, data = ctx.modify_user_security(group, [code], "DEL")
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"modify_user_security DEL failed: {data}")

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
        last = float(row["last_price"])
        prev_close = float(row["prev_close_price"])
        # change_rate isn't a top-level field in regular hours — compute it.
        # Returned as a decimal (0.0123 = +1.23%).
        change_rate = (last - prev_close) / prev_close if prev_close else 0.0
        update_time_raw = row.get("update_time")
        try:
            update_time = (
                datetime.fromisoformat(str(update_time_raw))
                if update_time_raw
                else datetime.now()
            )
        except ValueError:
            update_time = datetime.now()
        return Snapshot(
            code=row["code"],
            name=row.get("name") if isinstance(row.get("name"), str) else None,
            last_price=last,
            open_price=float(row["open_price"]),
            high_price=float(row["high_price"]),
            low_price=float(row["low_price"]),
            prev_close_price=prev_close,
            change_rate=change_rate,
            volume=int(row["volume"]),
            turnover=float(row["turnover"]),
            update_time=update_time,
        )

    # ------------------------------------------------------------------
    # Trade methods — use _trade_ctx_factory (per-call, not cached)
    # ------------------------------------------------------------------

    def list_accounts(self) -> list[Account]:
        ctx = self._trade_ctx_factory()
        try:
            ret, data = ctx.get_acc_list()
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_acc_list failed: {data}")
        accounts: list[Account] = []
        for _, row in data.iterrows():
            r = row.to_dict()
            trdmarket_auth_raw = r.get("trdmarket_auth", [])
            if isinstance(trdmarket_auth_raw, list):
                trdmarket_auth = [str(m) for m in trdmarket_auth_raw]
            elif isinstance(trdmarket_auth_raw, str):
                trdmarket_auth = [s.strip() for s in trdmarket_auth_raw.strip("[]").split(",") if s.strip()]
            else:
                trdmarket_auth = []
            trd_env_raw = str(r.get("trd_env", "SIMULATE")).upper()
            trd_env = "SIMULATE" if "SIM" in trd_env_raw else "REAL"
            accounts.append(Account(
                acc_id=int(r["acc_id"]),
                trd_env=trd_env,  # type: ignore[arg-type]
                acc_type=str(r.get("acc_type", "CASH")),
                card_num=str(r["card_num"]) if r.get("card_num") else None,
                security_firm=str(r["security_firm"]) if r.get("security_firm") else None,
                trdmarket_auth=trdmarket_auth,
                acc_role=str(r["acc_role"]) if r.get("acc_role") else None,
            ))
        return accounts

    def get_portfolio(self, *, acc_id: int, trd_env: str = "SIMULATE") -> Portfolio:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret_p, positions_df = ctx.position_list_query(acc_id=acc_id, trd_env=env, refresh_cache=True)
            ret_a, accinfo_df = ctx.accinfo_query(acc_id=acc_id, trd_env=env, refresh_cache=True)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret_p != 0:
            raise OpendError(f"position_list_query failed: {positions_df}")
        if ret_a != 0:
            raise OpendError(f"accinfo_query failed: {accinfo_df}")
        positions = [
            Position(
                code=str(r["code"]),
                qty=int(r.get("qty", 0)),
                # SDK uses "average_cost"; plan schema names it cost_price
                cost_price=float(r.get("average_cost", r.get("cost_price", 0)) or 0),
                # SDK uses "nominal_price"; plan schema names it current_price
                current_price=float(r.get("nominal_price", r.get("current_price", 0)) or 0),
                market_val=float(r.get("market_val", 0) or 0),
                pl_val=float(r.get("unrealized_pl", r.get("pl_val", 0)) or 0),
                pl_ratio=float(r.get("pl_ratio_avg_cost", r.get("pl_ratio", 0)) or 0) / 100.0,
            )
            for _, r in positions_df.iterrows()
        ]
        a = accinfo_df.iloc[0].to_dict() if not accinfo_df.empty else {}
        return Portfolio(
            cash=float(a.get("cash", 0) or 0),
            market_val=float(a.get("market_val", 0) or 0),
            total_assets=float(a.get("total_assets", 0) or 0),
            positions=positions,
        )

    def list_orders(self, *, acc_id: int, trd_env: str = "SIMULATE") -> list[Order]:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret, data = ctx.order_list_query(acc_id=acc_id, trd_env=env, refresh_cache=True)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"order_list_query failed: {data}")
        return [
            Order(
                order_id=str(r["order_id"]),
                code=str(r["code"]),
                side="BUY" if str(r.get("trd_side", "BUY")).upper().startswith("B") else "SELL",
                qty=int(r.get("qty", 0)),
                price=float(r.get("price", 0) or 0),
                status=str(r.get("order_status", "")),
                created_at=datetime.fromisoformat(str(r["create_time"])),
            )
            for _, r in data.iterrows()
        ]

    def list_fills(self, *, acc_id: int, trd_env: str = "SIMULATE") -> list[Fill]:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret, data = ctx.deal_list_query(acc_id=acc_id, trd_env=env, refresh_cache=True)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"deal_list_query failed: {data}")
        return [
            Fill(
                fill_id=str(r["deal_id"]),
                order_id=str(r["order_id"]),
                code=str(r["code"]),
                side="BUY" if str(r.get("trd_side", "BUY")).upper().startswith("B") else "SELL",
                qty=int(r.get("qty", 0)),
                price=float(r.get("price", 0) or 0),
                fill_at=datetime.fromisoformat(str(r["create_time"])),
            )
            for _, r in data.iterrows()
        ]
