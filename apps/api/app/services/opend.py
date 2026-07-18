from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from app.schemas.quote import Bar, KLineResponse, KLineType, OrderBook, OrderBookLevel, Snapshot
from app.schemas.trade import Account, Fill, Order, PlaceOrderResult, Portfolio, Position
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
        rsa_key_path: str | None = None,
        _ctx_factory: Callable[[], Any] | None = None,
        _trade_ctx_factory: Callable[[], Any] | None = None,
    ) -> None:
        self._host = host
        self._port = port
        self._rsa_key_path = rsa_key_path
        self._ctx_factory = _ctx_factory or self._default_ctx_factory
        self._trade_ctx_factory = _trade_ctx_factory or self._default_trade_ctx_factory

    def _default_ctx_factory(self) -> Any:
        # OpenD enforces InitConnect-handshake encryption on every non-loopback
        # connection (both quote and trade) once it's started with
        # -rsa_pri_key_path. Without is_encrypt=True here, quote handshakes
        # fail with "check sha error" because the integrity hash OpenD computes
        # against the RSA key won't match a plaintext request.
        from moomoo import OpenQuoteContext, SysConfig  # type: ignore[import-not-found]
        kwargs: dict[str, Any] = {"host": self._host, "port": self._port}
        if self._rsa_key_path:
            SysConfig.set_init_rsa_file(self._rsa_key_path)
            kwargs["is_encrypt"] = True
        return OpenQuoteContext(**kwargs)

    def _default_trade_ctx_factory(self) -> Any:
        # Trade has the same encryption requirement as quote (see
        # _default_ctx_factory). OpenD's original error wording for trade —
        # "cross-network trade connections must be encrypted" — is what first
        # surfaced the constraint.
        from moomoo import OpenSecTradeContext, SecurityFirm, SysConfig, TrdMarket  # type: ignore[import-not-found]
        kwargs: dict[str, Any] = {
            "host": self._host,
            "port": self._port,
            "filter_trdmarket": TrdMarket.NONE,
            "security_firm": SecurityFirm.NONE,
        }
        if self._rsa_key_path:
            SysConfig.set_init_rsa_file(self._rsa_key_path)
            kwargs["is_encrypt"] = True
        return OpenSecTradeContext(**kwargs)

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

    def get_global_state(self) -> dict[str, bool | str | int]:
        """Probe OpenD reachability + login state. Cheap call.

        Returns a small dict with reachable + login flags so the UI can
        decide whether to render a green or red status indicator. If the
        connection itself fails, returns reachable=False without raising
        (the caller wants to render "down" not 500).
        """
        try:
            ctx = self._ctx_factory()
        except Exception:
            return {"reachable": False, "qot_logined": False, "trd_logined": False}
        try:
            ret, data = ctx.get_global_state()
        except Exception:
            return {"reachable": False, "qot_logined": False, "trd_logined": False}
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            return {"reachable": False, "qot_logined": False, "trd_logined": False}
        d = data if isinstance(data, dict) else {}
        return {
            "reachable": True,
            "qot_logined": bool(d.get("qot_logined", False)),
            "trd_logined": bool(d.get("trd_logined", False)),
            "server_ver": str(d.get("server_ver", "")),
        }

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

    def _modify_watchlist(self, code: str, *, group: str, op_name: str) -> None:
        """Apply ADD/DEL via SDK. Args are positional (group, op, codes) and op
        must be a ModifyUserSecurityOp enum member (raw strings are rejected
        despite the misleading 'must str' error message)."""
        ctx = self._ctx_factory()
        try:
            try:
                from moomoo import ModifyUserSecurityOp  # type: ignore[import-not-found]
                op = getattr(ModifyUserSecurityOp, op_name)
            except ImportError:
                op = op_name  # tests against fake ctx accept the bare string
            ret, data = ctx.modify_user_security(group, op, [code])
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"modify_user_security {op_name} failed: {data}")

    def add_watchlist_item(self, code: str, *, group: str = "All") -> None:
        self._modify_watchlist(code, group=group, op_name="ADD")

    def remove_watchlist_item(self, code: str, *, group: str = "All") -> None:
        self._modify_watchlist(code, group=group, op_name="DEL")

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

    def get_order_book(self, code: str, *, num: int = 10) -> OrderBook:
        """Fetch a one-shot real-time order book after subscribing to depth.

        The moomoo SDK requires an ORDER_BOOK subscription before
        get_order_book can return data. This method performs that subscription
        only for the current short-lived quote context, then closes the context.
        """
        ctx = self._ctx_factory()
        try:
            try:
                from moomoo import SubType  # type: ignore[import-not-found]
                is_real_sdk = "moomoo" in str(type(ctx))
                subtype = SubType.ORDER_BOOK if is_real_sdk else "ORDER_BOOK"
            except ImportError:
                subtype = "ORDER_BOOK"

            sub_result = ctx.subscribe([code], [subtype], subscribe_push=False)
            sub_ret = sub_result[0] if isinstance(sub_result, tuple | list) else sub_result
            sub_msg = sub_result[1] if isinstance(sub_result, tuple | list) and len(sub_result) > 1 else sub_result
            if sub_ret != 0:
                raise OpendError(f"subscribe ORDER_BOOK failed: {sub_msg}")

            ret, data = ctx.get_order_book(code, num=num)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"get_order_book failed: {data}")

        def _levels(rows: object) -> list[OrderBookLevel]:
            levels: list[OrderBookLevel] = []
            if not isinstance(rows, list):
                return levels
            for row in rows:
                if not isinstance(row, tuple | list) or len(row) < 3:
                    continue
                details = row[3] if len(row) > 3 and isinstance(row[3], dict) else {}
                levels.append(OrderBookLevel(
                    price=float(row[0]),
                    volume=int(row[1]),
                    order_count=int(row[2]),
                    details=details,
                ))
            return levels

        book = data if isinstance(data, dict) else {}
        return OrderBook(
            code=str(book.get("code", code)),
            name=str(book["name"]) if book.get("name") else None,
            bid_time=str(book["svr_recv_time_bid"]) if book.get("svr_recv_time_bid") else None,
            ask_time=str(book["svr_recv_time_ask"]) if book.get("svr_recv_time_ask") else None,
            bids=_levels(book.get("Bid")),
            asks=_levels(book.get("Ask")),
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
                acc_id=str(int(r["acc_id"])),  # str-on-wire (int parse normalises whitespace/locale)
                trd_env=trd_env,  # type: ignore[arg-type]
                acc_type=str(r.get("acc_type", "CASH")),
                card_num=str(r["card_num"]) if r.get("card_num") else None,
                security_firm=str(r["security_firm"]) if r.get("security_firm") else None,
                trdmarket_auth=trdmarket_auth,
                acc_role=str(r["acc_role"]) if r.get("acc_role") else None,
            ))
        return accounts

    def get_portfolio(self, *, acc_id: str, trd_env: str = "SIMULATE") -> Portfolio:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret_p, positions_df = ctx.position_list_query(acc_id=int(acc_id), trd_env=env, refresh_cache=True)
            ret_a, accinfo_df = ctx.accinfo_query(acc_id=int(acc_id), trd_env=env, refresh_cache=True)
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret_p != 0:
            raise OpendError(f"position_list_query failed: {positions_df}")
        if ret_a != 0:
            raise OpendError(f"accinfo_query failed: {accinfo_df}")
        def _to_float(value: object) -> float:
            """moomoo returns 'N/A' as a string for unset paper-account fields;
            coerce those (and other non-numeric junk) to 0.0 instead of raising."""
            if value is None or value == "" or value == "N/A":
                return 0.0
            try:
                return float(value)
            except (TypeError, ValueError):
                return 0.0

        def _currency(value: object) -> str | None:
            """moomoo reports a settlement currency (USD/HKD/…) per position and
            per account. Missing/'N/A' values coerce to None so downstream never
            treats a blank as USD."""
            if value is None or value == "" or value == "N/A":
                return None
            text = str(value).strip()
            return text or None

        positions = [
            Position(
                code=str(r["code"]),
                qty=int(_to_float(r.get("qty", 0))),
                # SDK uses "average_cost"; plan schema names it cost_price
                cost_price=_to_float(r.get("average_cost", r.get("cost_price", 0))),
                # SDK uses "nominal_price"; plan schema names it current_price
                current_price=_to_float(r.get("nominal_price", r.get("current_price", 0))),
                market_val=_to_float(r.get("market_val", 0)),
                pl_val=_to_float(r.get("unrealized_pl", r.get("pl_val", 0))),
                pl_ratio=_to_float(r.get("pl_ratio_avg_cost", r.get("pl_ratio", 0))) / 100.0,
                currency=_currency(r.get("currency")),
            )
            for _, r in positions_df.iterrows()
        ]
        a = accinfo_df.iloc[0].to_dict() if not accinfo_df.empty else {}
        # moomoo exposes native per-currency cash alongside the base-currency
        # aggregate. The base `cash` field is every currency converted into the
        # account's home currency (accinfo `currency`, often HKD), so it must
        # NOT be read as a native balance. These *_cash columns are the real
        # per-currency holdings. Only non-zero balances are surfaced.
        cash_col_to_ccy = {
            "us_cash": "USD",
            "hk_cash": "HKD",
            "cn_cash": "CNH",
            "jp_cash": "JPY",
            "sg_cash": "SGD",
            "au_cash": "AUD",
            "ca_cash": "CAD",
            "my_cash": "MYR",
        }
        cash_by_currency: dict[str, float] = {}
        for col, ccy in cash_col_to_ccy.items():
            amount = _to_float(a.get(col))  # 'N/A'/None/'' -> 0.0
            if amount:
                cash_by_currency[ccy] = cash_by_currency.get(ccy, 0.0) + amount
        return Portfolio(
            cash=_to_float(a.get("cash", 0)),
            market_val=_to_float(a.get("market_val", 0)),
            total_assets=_to_float(a.get("total_assets", 0)),
            positions=positions,
            currency=_currency(a.get("currency")),
            cash_by_currency=cash_by_currency,
        )

    def list_orders(self, *, acc_id: str, trd_env: str = "SIMULATE") -> list[Order]:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret, data = ctx.order_list_query(acc_id=int(acc_id), trd_env=env, refresh_cache=True)
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

    def _resolve_trd_env(self, trd_env: str) -> Any:
        """Translate our string env to the SDK enum (or pass through for tests)."""
        try:
            from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
            return MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
        except ImportError:
            return trd_env

    def _first_simulate_acc_id(self, ctx: Any) -> str:
        """Find the first SIMULATE account on the connected ctx (used when the
        caller didn't specify an acc_id). Raises OpendError if none."""
        ret, data = ctx.get_acc_list()
        if ret != 0:
            raise OpendError(f"get_acc_list failed: {data}")
        for _, row in data.iterrows():
            r = row.to_dict()
            env_str = str(r.get("trd_env", "")).upper()
            if "SIM" in env_str:
                return str(int(r["acc_id"]))
        raise OpendError("no SIMULATE account on this OpenD")

    def place_order(
        self,
        *,
        code: str,
        side: str,
        qty: int,
        price: float | None = None,
        order_type: str = "NORMAL",
        trd_env: str = "SIMULATE",
        acc_id: str | None = None,
    ) -> PlaceOrderResult:
        """Place a paper or live order. For NORMAL orders price is required.
        For MARKET orders price is ignored (we pass 0 — SDK accepts that for
        market orders on supported markets)."""
        if order_type == "NORMAL" and price is None:
            raise OpendError("price is required for NORMAL (limit) orders")
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import OrderType as MoomooOrderType, TrdSide  # type: ignore[import-not-found]
                sdk_side = TrdSide.BUY if side == "BUY" else TrdSide.SELL
                sdk_type = MoomooOrderType.NORMAL if order_type == "NORMAL" else MoomooOrderType.MARKET
            except ImportError:
                sdk_side = side
                sdk_type = order_type
            env = self._resolve_trd_env(trd_env)
            resolved_acc_id = acc_id if acc_id is not None else self._first_simulate_acc_id(ctx)
            ret, data = ctx.place_order(
                price=price if price is not None else 0,
                qty=qty,
                code=code,
                trd_side=sdk_side,
                order_type=sdk_type,
                trd_env=env,
                acc_id=int(resolved_acc_id),
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"place_order failed: {data}")
        row = data.iloc[0].to_dict() if hasattr(data, "iloc") else data
        return PlaceOrderResult(
            order_id=str(row["order_id"]),
            code=str(row.get("code", code)),
            side="BUY" if side == "BUY" else "SELL",
            qty=int(row.get("qty", qty)),
            price=float(row.get("price", price or 0) or 0),
            status=str(row.get("order_status", "SUBMITTED")),
            trd_env=trd_env,  # type: ignore[arg-type]
            acc_id=str(int(row.get("acc_id", resolved_acc_id))),
        )

    def modify_order(
        self,
        *,
        order_id: str,
        acc_id: str,
        price: float | None = None,
        qty: int | None = None,
        trd_env: str = "SIMULATE",
    ) -> dict[str, str]:
        if price is None and qty is None:
            raise OpendError("modify_order: provide at least one of price or qty")
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import ModifyOrderOp  # type: ignore[import-not-found]
                op = ModifyOrderOp.NORMAL
            except ImportError:
                op = "NORMAL"
            env = self._resolve_trd_env(trd_env)
            ret, data = ctx.modify_order(
                modify_order_op=op,
                order_id=order_id,
                qty=qty if qty is not None else 0,
                price=price if price is not None else 0,
                acc_id=int(acc_id),
                trd_env=env,
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"modify_order failed: {data}")
        return {"order_id": order_id, "status": "MODIFIED"}

    def cancel_order(
        self,
        *,
        order_id: str,
        acc_id: str,
        trd_env: str = "SIMULATE",
    ) -> dict[str, str]:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import ModifyOrderOp  # type: ignore[import-not-found]
                op = ModifyOrderOp.CANCEL
            except ImportError:
                op = "CANCEL"
            env = self._resolve_trd_env(trd_env)
            ret, data = ctx.modify_order(
                modify_order_op=op,
                order_id=order_id,
                qty=0,
                price=0,
                acc_id=int(acc_id),
                trd_env=env,
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"cancel_order failed: {data}")
        return {"order_id": order_id, "status": "CANCELLED"}

    def list_fills(self, *, acc_id: str, trd_env: str = "SIMULATE") -> list[Fill]:
        ctx = self._trade_ctx_factory()
        try:
            try:
                from moomoo import TrdEnv as MoomooTrdEnv  # type: ignore[import-not-found]
                env = MoomooTrdEnv.SIMULATE if trd_env == "SIMULATE" else MoomooTrdEnv.REAL
            except ImportError:
                env = trd_env
            ret, data = ctx.deal_list_query(acc_id=int(acc_id), trd_env=env, refresh_cache=True)
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

    def list_history_orders(
        self,
        *,
        acc_id: str,
        trd_env: str = "SIMULATE",
        start: str | None = None,
        end: str | None = None,
        code: str = "",
    ) -> list[Order]:
        """Historical orders via history_order_list_query.

        ``start``/``end`` are YYYY-MM-DD strings; empty means "let the SDK use
        its default window". Unlike order_list_query this hits the server-side
        history store, so it is not limited to today's session.
        """
        ctx = self._trade_ctx_factory()
        try:
            env = self._resolve_trd_env(trd_env)
            ret, data = ctx.history_order_list_query(
                code=code or "",
                start=start or "",
                end=end or "",
                trd_env=env,
                acc_id=int(acc_id),
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"history_order_list_query failed: {data}")
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

    def list_history_fills(
        self,
        *,
        acc_id: str,
        trd_env: str = "SIMULATE",
        start: str | None = None,
        end: str | None = None,
        code: str = "",
    ) -> list[Fill]:
        """Historical fills (executed deals) via history_deal_list_query.

        Same range semantics as :meth:`list_history_orders`.
        """
        ctx = self._trade_ctx_factory()
        try:
            env = self._resolve_trd_env(trd_env)
            ret, data = ctx.history_deal_list_query(
                code=code or "",
                start=start or "",
                end=end or "",
                trd_env=env,
                acc_id=int(acc_id),
            )
        finally:
            try:
                ctx.close()
            except Exception:
                pass
        if ret != 0:
            raise OpendError(f"history_deal_list_query failed: {data}")
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
