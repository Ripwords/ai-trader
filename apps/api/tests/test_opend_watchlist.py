import pytest

from app.services.opend import OpendAdapter, OpendError


class FakeWatchlistCtx:
    def __init__(self, security_payload=None, modify_ret=0, fail=False):
        self._payload = security_payload or []
        self._modify_ret = modify_ret
        self._fail = fail
        self.modify_calls: list[tuple[str, list[str], str]] = []

    def get_user_security(self, group):
        if self._fail:
            return -1, "boom"
        import pandas as pd
        return 0, pd.DataFrame([row for row in self._payload if row.get("group") == group or group == "All"])

    def modify_user_security(self, group, op, codes):
        self.modify_calls.append((group, op, codes))
        if self._modify_ret != 0:
            return self._modify_ret, "modify failed"
        return 0, None

    def close(self):
        pass


_ctx: FakeWatchlistCtx | None = None


def _set(ctx):
    global _ctx
    _ctx = ctx


def test_list_watchlist_returns_items():
    _set(FakeWatchlistCtx(security_payload=[
        {"code": "US.NVDA", "name": "NVIDIA", "group": "All"},
        {"code": "HK.00700", "name": "Tencent", "group": "All"},
    ]))
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    items = a.list_watchlist(group="All")
    assert len(items) == 2
    assert items[0].code == "US.NVDA"


def test_add_watchlist_item_calls_modify():
    fake = FakeWatchlistCtx()
    _set(fake)
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    a.add_watchlist_item("US.AAPL", group="All")
    # SDK signature: (group, op, codes). Op is the enum from moomoo (or the
    # raw string when running tests without the SDK installed).
    assert len(fake.modify_calls) == 1
    group, op, codes = fake.modify_calls[0]
    assert (group, codes) == ("All", ["US.AAPL"])
    assert str(op) == "ADD" or op == "ADD"


def test_remove_watchlist_item_calls_modify():
    fake = FakeWatchlistCtx()
    _set(fake)
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    a.remove_watchlist_item("US.AAPL", group="All")
    assert len(fake.modify_calls) == 1
    group, op, codes = fake.modify_calls[0]
    assert (group, codes) == ("All", ["US.AAPL"])
    assert str(op) == "DEL" or op == "DEL"


def test_modify_raises_on_error():
    _set(FakeWatchlistCtx(modify_ret=-1))
    a = OpendAdapter(host="ignored", port=0, _ctx_factory=lambda: _ctx)
    with pytest.raises(OpendError):
        a.add_watchlist_item("US.AAPL", group="All")
