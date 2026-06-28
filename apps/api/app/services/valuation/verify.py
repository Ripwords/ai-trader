from __future__ import annotations

from decimal import Decimal


def cross_source_check(
    values_by_source: dict[str, Decimal],
    tolerance: Decimal = Decimal("0.01"),
) -> tuple[bool, str | None]:
    """Return (discrepant, message). Discrepant when spread/median > tolerance.

    ai-berkshire's dual-source rule: critical numbers need two independent
    sources; a >1% gap is surfaced, not silently averaged."""
    vals = [v for v in values_by_source.values() if v is not None]
    if len(vals) < 2:
        return False, None
    lo, hi = min(vals), max(vals)
    srt = sorted(vals)
    mid = len(srt) // 2
    median = srt[mid] if len(srt) % 2 == 1 else (srt[mid - 1] + srt[mid]) / Decimal("2")
    if median == 0:
        return False, None
    spread = (hi - lo) / median
    if spread > tolerance:
        pct = (spread * Decimal("100")).quantize(Decimal("0.01"))
        return True, f"cross-source spread {pct}% exceeds {tolerance * 100}% across {list(values_by_source)}"
    return False, None


def verify_market_cap(
    price: Decimal,
    shares: Decimal,
    reported: Decimal,
    tolerance: Decimal = Decimal("0.01"),
) -> tuple[bool, str | None]:
    """Verify market cap by comparing computed (price * shares) against reported.

    Returns (match, message). Match is True when computed and reported are within
    tolerance; False when they diverge by >1% (default)."""
    computed = price * shares
    discrepant, msg = cross_source_check(
        {"computed": computed, "reported": reported}, tolerance
    )
    return (not discrepant), (
        None
        if not discrepant
        else f"market cap mismatch: computed {computed} vs reported {reported}"
    )
