import pytest

from app.schemas.quote import KLineResponse, Snapshot
from app.services.opend import OpendAdapter, OpendError


class FakeQuoteCtx:
    def __init__(self, kline_payload=None, snapshot_payload=None, fail=False):
        self._kline = kline_payload
        self._snapshot = snapshot_payload
        self._fail = fail
        self.subscriptions = []

    def get_cur_kline(self, code, num, ktype, autype):
        if self._fail:
            return -1, "boom"
        return 0, _df_from_rows(self._kline)

    def get_market_snapshot(self, codes):
        if self._fail:
            return -1, "boom"
        return 0, _df_from_rows(self._snapshot)

    def subscribe(self, codes, subtypes, subscribe_push=False):
        self.subscriptions.append((codes, subtypes, subscribe_push))
        if self._fail:
            return -1, "subscription failed"
        return 0, None

    def get_order_book(self, code, num=10):
        if self._fail:
            return -1, "boom"
        return 0, {
            "code": code,
            "name": "NVIDIA",
            "svr_recv_time_bid": "2026-05-07 16:00:00.000",
            "svr_recv_time_ask": "2026-05-07 16:00:00.000",
            "Bid": [(125.40, 300, 2, {"broker": "bid"})],
            "Ask": [(125.50, 200, 1, {"broker": "ask"})],
        }

    def close(self):
        pass


def _df_from_rows(rows):
    import pandas as pd
    return pd.DataFrame(rows)


# NOTE: module-level state is not safe for pytest-xdist parallel workers.
_ctx: FakeQuoteCtx | None = None


def _set_ctx(ctx):
    global _ctx
    _ctx = ctx


def test_get_kline_returns_typed_bars():
    _set_ctx(
        FakeQuoteCtx(
            kline_payload=[
                {
                    "time_key": "2026-05-06 00:00:00",
                    "open": 100.0,
                    "high": 110.0,
                    "low": 95.0,
                    "close": 108.0,
                    "volume": 1234,
                    "turnover": 130000.0,
                }
            ]
        )
    )
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    res = a.get_kline("US.NVDA", ktype="1d", num=1)
    assert isinstance(res, KLineResponse)
    assert res.code == "US.NVDA"
    assert res.ktype == "1d"
    assert len(res.bars) == 1
    assert res.bars[0].close == 108.0


def test_get_kline_raises_on_sdk_error():
    _set_ctx(FakeQuoteCtx(fail=True))
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    with pytest.raises(OpendError):
        a.get_kline("US.NVDA", ktype="1d", num=1)


def test_get_snapshot_returns_typed_snapshot():
    _set_ctx(
        FakeQuoteCtx(
            snapshot_payload=[
                {
                    "code": "US.NVDA",
                    "name": "NVIDIA",
                    "last_price": 125.5,
                    "open_price": 120.0,
                    "high_price": 126.0,
                    "low_price": 119.5,
                    "prev_close_price": 121.0,
                    "change_rate": 0.0372,
                    "volume": 12_345_678,
                    "turnover": 1_500_000_000.0,
                    "update_time": "2026-05-07 16:00:00",
                }
            ]
        )
    )
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    snap = a.get_snapshot("US.NVDA")
    assert isinstance(snap, Snapshot)
    assert snap.last_price == 125.5


def test_get_order_book_subscribes_and_normalizes_levels():
    ctx = FakeQuoteCtx()
    _set_ctx(ctx)
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    book = a.get_order_book("US.NVDA", num=5)

    assert ctx.subscriptions == [(["US.NVDA"], ["ORDER_BOOK"], False)]
    assert book.code == "US.NVDA"
    assert book.bids[0].price == 125.40
    assert book.bids[0].order_count == 2
    assert book.asks[0].details == {"broker": "ask"}
