# Valuation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, `Decimal`-precision valuation engine (DCF, reverse-DCF, 3-scenario target, margin of safety, multiples) ported from `xbtlin/ai-berkshire`'s methodology, exposed as both a chat copilot tool and an injected input + soft veto in the LangGraph verdict pipeline.

**Architecture:** A pure-Python, zero-I/O core (`apps/api/app/services/valuation/`) holds all math and is unit-tested against hand-computed golden values. A new web internal route surfaces the 5yr Yahoo history the engine needs (data already produced by `getHistorical()`, currently discarded by the toolkit). The core is exposed via a FastAPI `GET /valuation` endpoint (→ chat tool + card) and computed once per pipeline run (→ judge-context injection + post-hoc soft veto).

**Tech Stack:** Python 3.12 / FastAPI / pydantic / `decimal` (api); Nuxt 4 / Nitro / h3 / Zod / Vue 3 / TanStack Query (web); pytest (api tests), vitest + `nuxi typecheck` (web tests).

## Global Constraints

- **ai-berkshire methodology takes precedence** over local convention wherever they diverge. Load-bearing, non-negotiable: all money math uses `decimal.Decimal` with `getcontext().prec = 28` and `ROUND_HALF_EVEN`; never do float arithmetic on financials. The >1% cross-source discrepancy rule, the reverse-DCF reality check, and 3 scenarios (optimistic/neutral/pessimistic) are required outputs, not optional.
- **Never fabricate a fair value on sparse data.** Negative/zero FCF, missing history, or zero shares → return a multiples-only result with `fair_value=None`, a downgraded `data_quality`, and a `warnings[]` entry. No invented numbers.
- TypeScript: never use `any`; never re-define API return types in the frontend (import from server types). React/Next rules N/A (this is Nuxt/Vue).
- Conventional Commits. TDD: failing test first, then implementation.
- Run tests locally (NOT in Docker): api `cd apps/api && uv run pytest`; web `cd apps/web && npx vitest run` and `npx nuxi typecheck`.
- After editing `apps/web` or `apps/api`, rebuild the affected container: `docker compose up -d --build {web|api}` (neither bind-mounts source).
- Internal web routes require bearer auth via `requireInternalBearer(event)`; api internal endpoints use `Depends(require_internal_bearer)`.
- Rating severity scale (used by the veto): `strong-buy`(4) > `buy`(3) > `hold`(2) > `reduce`(1) > `sell`(0). The five wire ratings are exactly `strong-buy | buy | hold | reduce | sell` (`strong-sell` collapses to `sell`).

---

## Phase A — Deterministic core (pure Python, fully tested)

### Task 1: Valuation data models

**Files:**
- Create: `apps/api/app/services/valuation/__init__.py`
- Create: `apps/api/app/services/valuation/models.py`
- Test: `apps/api/tests/services/valuation/test_models.py`

**Interfaces:**
- Produces: pydantic models `Assumptions`, `HistoryPeriod`, `Metrics`, `ValuationInput`, `Scenario`, `Multiples`, `Veto`, `ValuationResult`. Money fields are `Decimal`. `data_quality: Literal["full","multiples_only","unavailable"]`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_models.py
from decimal import Decimal
from app.services.valuation.models import (
    Assumptions, HistoryPeriod, Metrics, ValuationInput, ValuationResult, Veto,
)


def test_valuation_result_minimal_unavailable():
    res = ValuationResult(
        symbol="AAPL",
        current_price=Decimal("100"),
        fair_value=None,
        margin_of_safety_pct=None,
        scenarios=[],
        assumptions_used=None,
        multiples=None,
        historical_multiples=None,
        reverse_dcf_implied_growth=None,
        data_quality="unavailable",
        veto=Veto(triggered=False, reason=None, rating_cap=None),
        warnings=["no data"],
    )
    assert res.symbol == "AAPL"
    assert res.fair_value is None
    assert res.data_quality == "unavailable"


def test_valuation_input_decimal_coercion():
    vi = ValuationInput(
        symbol="AAPL",
        current_price=Decimal("190.50"),
        fcf_base=Decimal("100000000000"),
        net_debt=Decimal("0"),
        shares_outstanding=Decimal("15000000000"),
        beta=Decimal("1.2"),
        history=[HistoryPeriod(period="2024", revenue=Decimal("1"), net_income=None,
                               fcf=Decimal("100"), total_debt=None, shareholders_equity=None)],
        metrics=Metrics(market_cap=Decimal("3e12"), pe_ratio=None, pb_ratio=None,
                        ps_ratio=Decimal("7"), eps=None, free_cash_flow=Decimal("1e11"),
                        shares_outstanding=Decimal("15e9"), beta=Decimal("1.2")),
    )
    assert vi.beta == Decimal("1.2")
    assert isinstance(vi.fcf_base, Decimal)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.valuation'`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/__init__.py
"""Deterministic valuation engine (DCF, scenarios, multiples).

Pure-Python, Decimal-precision, zero-I/O. The library form of
ai-berkshire's financial_rigor.py. See
docs/superpowers/specs/2026-06-28-valuation-engine-design.md.
"""
```

```python
# apps/api/app/services/valuation/models.py
from __future__ import annotations

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict


class _Model(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=False)


class HistoryPeriod(_Model):
    period: str
    revenue: Decimal | None = None
    net_income: Decimal | None = None
    fcf: Decimal | None = None
    total_debt: Decimal | None = None
    shareholders_equity: Decimal | None = None


class Metrics(_Model):
    market_cap: Decimal | None = None
    pe_ratio: Decimal | None = None
    pb_ratio: Decimal | None = None
    ps_ratio: Decimal | None = None
    eps: Decimal | None = None
    free_cash_flow: Decimal | None = None
    shares_outstanding: Decimal | None = None
    beta: Decimal | None = None


class Assumptions(_Model):
    growth_rates: list[Decimal]
    discount_rate: Decimal
    terminal_growth: Decimal


class ValuationInput(_Model):
    symbol: str
    current_price: Decimal
    fcf_base: Decimal | None
    net_debt: Decimal
    shares_outstanding: Decimal | None
    beta: Decimal | None
    history: list[HistoryPeriod]
    metrics: Metrics


class Scenario(_Model):
    name: Literal["optimistic", "neutral", "pessimistic"]
    growth: Decimal
    discount: Decimal
    fair_value: Decimal
    probability: Decimal


class Multiples(_Model):
    pe: Decimal | None = None
    pb: Decimal | None = None
    ps: Decimal | None = None
    p_fcf: Decimal | None = None


class Veto(_Model):
    triggered: bool
    reason: str | None
    rating_cap: str | None


class ValuationResult(_Model):
    symbol: str
    current_price: Decimal
    fair_value: Decimal | None
    margin_of_safety_pct: Decimal | None
    scenarios: list[Scenario]
    assumptions_used: Assumptions | None
    multiples: Multiples | None
    historical_multiples: Multiples | None
    reverse_dcf_implied_growth: Decimal | None
    data_quality: Literal["full", "multiples_only", "unavailable"]
    veto: Veto
    warnings: list[str] = []
```

Also create empty `apps/api/tests/services/valuation/__init__.py` if the test package needs it (mirror existing `apps/api/tests/` layout — check whether sibling test dirs have `__init__.py`; create only if they do).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_models.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation apps/api/tests/services/valuation
git commit -m "feat(valuation): add pydantic models for valuation engine"
```

---

### Task 2: DCF + margin of safety + reverse-DCF math

**Files:**
- Create: `apps/api/app/services/valuation/engine.py`
- Test: `apps/api/tests/services/valuation/test_engine.py`

**Interfaces:**
- Consumes: nothing (pure math on `Decimal`).
- Produces:
  - `dcf(fcf_base: Decimal, growth_rates: list[Decimal], discount_rate: Decimal, terminal_growth: Decimal, net_debt: Decimal, shares: Decimal) -> Decimal` (fair value per share).
  - `margin_of_safety(fair_value: Decimal, price: Decimal) -> Decimal` (fraction; positive = undervalued).
  - `reverse_dcf(price, fcf_base, discount_rate, terminal_growth, net_debt, shares) -> Decimal` (single implied annual growth held flat across the explicit window).
  - Module sets `getcontext().prec = 28`; all rounding `ROUND_HALF_EVEN`.

- [ ] **Step 1: Write the failing test**

Golden values hand-computed for: `fcf_base=100, growth=[0.10,0.10], discount=0.10, terminal=0.025, net_debt=0, shares=10`.
Year1 PV = 110/1.10 = 100; Year2 PV = 121/1.21 = 100; terminal = 121·1.025/(0.10−0.025) = 1653.6̄6, PV = /1.21 = 1366.6̄6; EV = 1566.6̄6; /10 = **156.6̄6 → 156.67**. At price 117.50, MoS = (156.6̄6−117.5)/156.6̄6 = **0.25**.

```python
# apps/api/tests/services/valuation/test_engine.py
from decimal import Decimal
from app.services.valuation.engine import dcf, margin_of_safety, reverse_dcf

D = Decimal


def _q(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"))


def test_dcf_two_stage_golden():
    fv = dcf(D("100"), [D("0.10"), D("0.10")], D("0.10"), D("0.025"), D("0"), D("10"))
    assert _q(fv) == D("156.67")


def test_margin_of_safety_quarter():
    mos = margin_of_safety(D("156.666667"), D("117.50"))
    assert mos.quantize(D("0.0001")) == D("0.2500")


def test_margin_of_safety_overvalued_is_negative():
    mos = margin_of_safety(D("100"), D("150"))
    assert mos < 0


def test_reverse_dcf_roundtrip():
    # dcf at 12% flat growth -> fair value F; reverse_dcf(F) ~= 0.12
    fv = dcf(D("100"), [D("0.12")] * 5, D("0.10"), D("0.025"), D("0"), D("10"))
    implied = reverse_dcf(fv, D("100"), D("0.10"), D("0.025"), D("0"), D("10"),
                          explicit_years=5)
    assert abs(implied - D("0.12")) < D("0.001")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_engine.py -v`
Expected: FAIL — `ModuleNotFoundError` / `cannot import name 'dcf'`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/engine.py
from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, getcontext

getcontext().prec = 28

_TWO = Decimal("2")


def dcf(
    fcf_base: Decimal,
    growth_rates: list[Decimal],
    discount_rate: Decimal,
    terminal_growth: Decimal,
    net_debt: Decimal,
    shares: Decimal,
) -> Decimal:
    """Multi-stage FCF DCF -> fair value per share.

    Projects FCF over the explicit window (one rate per year in
    ``growth_rates``), adds a Gordon terminal value off the final projected
    FCF, discounts everything to PV, subtracts net debt, divides by shares.
    """
    if shares <= 0:
        raise ValueError("shares must be positive")
    if discount_rate <= terminal_growth:
        raise ValueError("discount_rate must exceed terminal_growth")

    fcf = fcf_base
    pv_sum = Decimal("0")
    for i, g in enumerate(growth_rates, start=1):
        fcf = fcf * (Decimal("1") + g)
        pv_sum += fcf / (Decimal("1") + discount_rate) ** i

    terminal_fcf = fcf * (Decimal("1") + terminal_growth)
    terminal_value = terminal_fcf / (discount_rate - terminal_growth)
    n = len(growth_rates)
    pv_terminal = terminal_value / (Decimal("1") + discount_rate) ** n

    enterprise_value = pv_sum + pv_terminal
    equity_value = enterprise_value - net_debt
    return equity_value / shares


def margin_of_safety(fair_value: Decimal, price: Decimal) -> Decimal:
    """(fair - price) / fair. Positive = undervalued, negative = overvalued."""
    if fair_value == 0:
        raise ValueError("fair_value must be non-zero")
    return (fair_value - price) / fair_value


def reverse_dcf(
    price: Decimal,
    fcf_base: Decimal,
    discount_rate: Decimal,
    terminal_growth: Decimal,
    net_debt: Decimal,
    shares: Decimal,
    explicit_years: int = 5,
) -> Decimal:
    """Bisection-solve the flat annual growth that makes ``dcf`` == ``price``.

    ai-berkshire's reality check: what growth does the current price imply?
    Searches g in [-0.50, 1.00]; returns the midpoint at convergence.
    """
    lo, hi = Decimal("-0.50"), Decimal("1.00")
    target = price
    for _ in range(200):
        mid = (lo + hi) / _TWO
        fv = dcf(fcf_base, [mid] * explicit_years, discount_rate,
                 terminal_growth, net_debt, shares)
        if abs(fv - target) < Decimal("0.0000001"):
            return mid
        if fv < target:
            lo = mid
        else:
            hi = mid
    return ((lo + hi) / _TWO).quantize(Decimal("0.000001"), ROUND_HALF_EVEN)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_engine.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/engine.py apps/api/tests/services/valuation/test_engine.py
git commit -m "feat(valuation): add DCF, margin of safety, reverse-DCF math"
```

---

### Task 3: Multiples (current + historical-self)

**Files:**
- Modify: `apps/api/app/services/valuation/engine.py`
- Test: `apps/api/tests/services/valuation/test_multiples.py`

**Interfaces:**
- Consumes: `Metrics`, `HistoryPeriod` from `models.py`.
- Produces:
  - `current_multiples(metrics: Metrics, price: Decimal) -> Multiples`.
  - `historical_self_multiples(history: list[HistoryPeriod], shares: Decimal, avg_price_by_period: dict[str, Decimal]) -> Multiples` — median P/E and P/S the company itself traded at across periods (returns medians; `None` fields when uncomputable).

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_multiples.py
from decimal import Decimal
from app.services.valuation.engine import current_multiples, historical_self_multiples
from app.services.valuation.models import Metrics, HistoryPeriod

D = Decimal


def test_current_multiples_passthrough_and_pfcf():
    m = Metrics(market_cap=D("1000"), pe_ratio=D("20"), pb_ratio=D("5"),
                ps_ratio=D("4"), free_cash_flow=D("50"), shares_outstanding=D("10"))
    out = current_multiples(m, price=D("100"))
    assert out.pe == D("20")
    assert out.ps == D("4")
    assert out.p_fcf == D("20")  # market_cap / fcf = 1000/50


def test_historical_self_multiples_median_ps():
    hist = [
        HistoryPeriod(period="2023", revenue=D("100")),
        HistoryPeriod(period="2024", revenue=D("200")),
    ]
    # shares=10; avg price 2023=50 -> mcap 500 / rev 100 = PS 5
    #            avg price 2024=40 -> mcap 400 / rev 200 = PS 2
    out = historical_self_multiples(hist, shares=D("10"),
                                    avg_price_by_period={"2023": D("50"), "2024": D("40")})
    assert out.ps == D("3.5")  # median of [5, 2]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_multiples.py -v`
Expected: FAIL — `cannot import name 'current_multiples'`

- [ ] **Step 3: Write minimal implementation** (append to `engine.py`)

```python
# --- append to apps/api/app/services/valuation/engine.py ---
from app.services.valuation.models import HistoryPeriod, Metrics, Multiples


def _median(values: list[Decimal]) -> Decimal | None:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    if len(vals) % 2 == 1:
        return vals[mid]
    return (vals[mid - 1] + vals[mid]) / Decimal("2")


def current_multiples(metrics: Metrics, price: Decimal) -> Multiples:
    p_fcf = None
    if metrics.market_cap and metrics.free_cash_flow and metrics.free_cash_flow != 0:
        p_fcf = metrics.market_cap / metrics.free_cash_flow
    return Multiples(
        pe=metrics.pe_ratio,
        pb=metrics.pb_ratio,
        ps=metrics.ps_ratio,
        p_fcf=p_fcf,
    )


def historical_self_multiples(
    history: list[HistoryPeriod],
    shares: Decimal,
    avg_price_by_period: dict[str, Decimal],
) -> Multiples:
    """Median P/E and P/S the company itself traded at, period by period.

    Uses current ``shares`` as a proxy market-cap base (period-exact share
    counts aren't in the Yahoo bundle) — good enough for a self-relative band.
    """
    pes: list[Decimal] = []
    pss: list[Decimal] = []
    for h in history:
        price = avg_price_by_period.get(h.period)
        if price is None or shares <= 0:
            continue
        mcap = price * shares
        if h.revenue and h.revenue != 0:
            pss.append(mcap / h.revenue)
        if h.net_income and h.net_income != 0:
            pes.append(mcap / h.net_income)
    return Multiples(pe=_median(pes), ps=_median(pss))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_multiples.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/engine.py apps/api/tests/services/valuation/test_multiples.py
git commit -m "feat(valuation): add current and historical-self multiples"
```

---

### Task 4: Auto-derived assumptions (FCF-CAGR growth, CAPM discount)

**Files:**
- Create: `apps/api/app/services/valuation/assumptions.py`
- Test: `apps/api/tests/services/valuation/test_assumptions.py`

**Interfaces:**
- Consumes: `HistoryPeriod`, `Assumptions` from `models.py`.
- Produces:
  - `derive_growth(history: list[HistoryPeriod]) -> Decimal` — FCF CAGR, capped to [-0.05, 0.20], haircut ×0.75. Returns `Decimal("0.03")` fallback when <2 positive FCF points.
  - `derive_discount_rate(beta: Decimal | None, rf: Decimal = Decimal("0.04"), erp: Decimal = Decimal("0.05")) -> Decimal` — CAPM `rf + beta·erp`; beta `None`→1. Floor 0.07, ceiling 0.15.
  - `build_default_assumptions(history, beta, explicit_years=5) -> Assumptions` — flat growth across the window, terminal 0.025.
  - `EXPLICIT_YEARS = 5`, `TERMINAL_GROWTH = Decimal("0.025")` module constants.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_assumptions.py
from decimal import Decimal
from app.services.valuation.assumptions import (
    derive_growth, derive_discount_rate, build_default_assumptions,
)
from app.services.valuation.models import HistoryPeriod

D = Decimal


def test_derive_discount_rate_capm():
    # 0.04 + 1.2 * 0.05 = 0.10
    assert derive_discount_rate(D("1.2")) == D("0.10")


def test_derive_discount_rate_floor_and_ceiling():
    assert derive_discount_rate(D("0")) == D("0.07")     # 0.04 -> floored to 0.07
    assert derive_discount_rate(D("5")) == D("0.15")     # huge beta -> capped


def test_derive_growth_caps_and_haircut():
    # history newest-first like Yahoo: fcf 100 (2024) ... 80 (2021); 3 intervals
    hist = [
        HistoryPeriod(period="2024", fcf=D("100")),
        HistoryPeriod(period="2023", fcf=D("92")),
        HistoryPeriod(period="2022", fcf=D("86")),
        HistoryPeriod(period="2021", fcf=D("80")),
    ]
    g = derive_growth(hist)
    # CAGR = (100/80)^(1/3)-1 = 0.0772; *0.75 haircut = 0.0579
    assert g.quantize(D("0.0001")) == D("0.0579")


def test_derive_growth_fallback_when_sparse():
    assert derive_growth([HistoryPeriod(period="2024", fcf=D("100"))]) == D("0.03")


def test_build_default_assumptions_shape():
    a = build_default_assumptions([HistoryPeriod(period="2024", fcf=D("100"))], D("1.0"))
    assert len(a.growth_rates) == 5
    assert a.terminal_growth == D("0.025")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_assumptions.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/assumptions.py
from __future__ import annotations

from decimal import Decimal

from app.services.valuation.models import Assumptions, HistoryPeriod

EXPLICIT_YEARS = 5
TERMINAL_GROWTH = Decimal("0.025")
_GROWTH_FLOOR = Decimal("-0.05")
_GROWTH_CAP = Decimal("0.20")
_GROWTH_HAIRCUT = Decimal("0.75")
_GROWTH_FALLBACK = Decimal("0.03")
_DISCOUNT_FLOOR = Decimal("0.07")
_DISCOUNT_CEIL = Decimal("0.15")


def derive_growth(history: list[HistoryPeriod]) -> Decimal:
    """Dampened FCF CAGR from the historical series (Yahoo order: newest-first).

    Falls back to 3% when fewer than two positive FCF points exist
    (ai-berkshire: don't fabricate a trend from no data)."""
    fcfs = [h.fcf for h in history if h.fcf is not None and h.fcf > 0]
    if len(fcfs) < 2:
        return _GROWTH_FALLBACK
    newest, oldest = fcfs[0], fcfs[-1]   # history is newest-first
    intervals = len(fcfs) - 1
    cagr = (newest / oldest) ** (Decimal("1") / Decimal(intervals)) - Decimal("1")
    cagr = max(_GROWTH_FLOOR, min(_GROWTH_CAP, cagr))
    return cagr * _GROWTH_HAIRCUT


def derive_discount_rate(
    beta: Decimal | None,
    rf: Decimal = Decimal("0.04"),
    erp: Decimal = Decimal("0.05"),
) -> Decimal:
    b = beta if beta is not None else Decimal("1")
    capm = rf + b * erp
    return max(_DISCOUNT_FLOOR, min(_DISCOUNT_CEIL, capm))


def build_default_assumptions(
    history: list[HistoryPeriod],
    beta: Decimal | None,
    explicit_years: int = EXPLICIT_YEARS,
) -> Assumptions:
    g = derive_growth(history)
    return Assumptions(
        growth_rates=[g] * explicit_years,
        discount_rate=derive_discount_rate(beta),
        terminal_growth=TERMINAL_GROWTH,
    )
```

Note: `Decimal ** Decimal` fractional exponent is supported in Python's `decimal` for the magnitudes here. If a future input raises `decimal.InvalidOperation`, the caller (Task 6) guards with try/except → fallback growth.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_assumptions.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/assumptions.py apps/api/tests/services/valuation/test_assumptions.py
git commit -m "feat(valuation): add auto-derived CAPM + FCF-CAGR assumptions"
```

---

### Task 5: Rigor checks (cross-source >1%, market-cap verify)

**Files:**
- Create: `apps/api/app/services/valuation/verify.py`
- Test: `apps/api/tests/services/valuation/test_verify.py`

**Interfaces:**
- Produces:
  - `cross_source_check(values_by_source: dict[str, Decimal], tolerance: Decimal = Decimal("0.01")) -> tuple[bool, str | None]` — `(discrepant, message)`; discrepant when `(max-min)/median > tolerance`.
  - `verify_market_cap(price: Decimal, shares: Decimal, reported: Decimal, tolerance: Decimal = Decimal("0.01")) -> tuple[bool, str | None]` — recompute `price·shares` vs reported.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_verify.py
from decimal import Decimal
from app.services.valuation.verify import cross_source_check, verify_market_cap

D = Decimal


def test_cross_source_within_tolerance():
    ok, msg = cross_source_check({"yahoo": D("100"), "moomoo": D("100.5")})
    assert ok is False  # not discrepant
    assert msg is None


def test_cross_source_exceeds_one_percent():
    discrepant, msg = cross_source_check({"yahoo": D("100"), "moomoo": D("103")})
    assert discrepant is True
    assert "3" in msg or "%" in msg


def test_verify_market_cap_matches():
    ok, _ = verify_market_cap(D("100"), D("10"), reported=D("1000"))
    assert ok is True


def test_verify_market_cap_mismatch():
    ok, msg = verify_market_cap(D("100"), D("10"), reported=D("2000"))
    assert ok is False
    assert msg is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_verify.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/verify.py
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
    computed = price * shares
    return cross_source_check(
        {"computed": computed, "reported": reported}, tolerance
    )[0] is False, (
        None
        if cross_source_check({"computed": computed, "reported": reported}, tolerance)[0] is False
        else f"market cap mismatch: computed {computed} vs reported {reported}"
    )
```

Simplify `verify_market_cap` to avoid the double call:

```python
def verify_market_cap(price, shares, reported, tolerance=Decimal("0.01")):
    computed = price * shares
    discrepant, msg = cross_source_check(
        {"computed": computed, "reported": reported}, tolerance
    )
    return (not discrepant), (None if not discrepant else
            f"market cap mismatch: computed {computed} vs reported {reported}")
```

Use the simplified version.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_verify.py -v`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/verify.py apps/api/tests/services/valuation/test_verify.py
git commit -m "feat(valuation): add cross-source >1% and market-cap rigor checks"
```

---

### Task 6: Compose `value()` orchestrator + soft-veto rule

**Files:**
- Create: `apps/api/app/services/valuation/compose.py`
- Test: `apps/api/tests/services/valuation/test_compose.py`

**Interfaces:**
- Consumes: everything in Tasks 1–5.
- Produces:
  - `value(vi: ValuationInput, overrides: Assumptions | None = None, avg_price_by_period: dict[str, Decimal] | None = None) -> ValuationResult`.
  - `apply_veto(rating: str, result: ValuationResult) -> tuple[str, Veto]` — caps `rating` per the veto rule; returns `(effective_rating, veto)`.
  - `RATING_SEVERITY: dict[str, int]` and helper `_cap_rating(rating, cap)`.
- Veto rule (pinned): trigger + `rating_cap="hold"` when **either** (a) DCF valid and `margin_of_safety_pct <= Decimal("-0.50")` (price ≥ 2× fair value), **or** (b) DCF valid and `reverse_dcf_implied_growth` is not None and `> Decimal("2.5") * derive_growth(history)` (and that derived growth > 0), **or** (c) multiples-only (no positive FCF) and `multiples.ps` not None and `ps > Decimal("30")`. Caps only `strong-buy`/`buy` down to `hold`; never forces `sell`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_compose.py
from decimal import Decimal
from app.services.valuation.compose import value, apply_veto, RATING_SEVERITY
from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

D = Decimal


def _history():
    return [
        HistoryPeriod(period="2024", fcf=D("100"), revenue=D("500"), net_income=D("80")),
        HistoryPeriod(period="2021", fcf=D("80"), revenue=D("400"), net_income=D("60")),
    ]


def test_value_full_quality_produces_three_scenarios():
    vi = ValuationInput(symbol="X", current_price=D("100"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.2"),
                        history=_history(),
                        metrics=Metrics(market_cap=D("1000"), ps_ratio=D("2"),
                                        free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "full"
    assert res.fair_value is not None
    assert len(res.scenarios) == 3
    assert res.reverse_dcf_implied_growth is not None


def test_value_negative_fcf_is_multiples_only_no_fabrication():
    vi = ValuationInput(symbol="X", current_price=D("100"), fcf_base=D("-50"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=[HistoryPeriod(period="2024", fcf=D("-50"))],
                        metrics=Metrics(ps_ratio=D("40"), shares_outstanding=D("10")))
    res = value(vi)
    assert res.data_quality == "multiples_only"
    assert res.fair_value is None
    assert any("FCF" in w or "fcf" in w for w in res.warnings)


def test_apply_veto_caps_buy_to_hold_when_grossly_overvalued():
    vi = ValuationInput(symbol="X", current_price=D("1000"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)  # fair value ~150ish << 1000 -> MoS very negative
    effective, veto = apply_veto("strong-buy", res)
    assert veto.triggered is True
    assert effective == "hold"


def test_apply_veto_does_not_lift_sell():
    vi = ValuationInput(symbol="X", current_price=D("1000"), fcf_base=D("100"),
                        net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.0"),
                        history=_history(),
                        metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    res = value(vi)
    effective, veto = apply_veto("sell", res)
    assert effective == "sell"  # cap never raises a bearish call


def test_rating_severity_ordering():
    assert RATING_SEVERITY["strong-buy"] > RATING_SEVERITY["hold"] > RATING_SEVERITY["sell"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_compose.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/compose.py
from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.services.valuation.assumptions import (
    EXPLICIT_YEARS, build_default_assumptions, derive_growth,
)
from app.services.valuation.engine import (
    current_multiples, dcf, historical_self_multiples, margin_of_safety, reverse_dcf,
)
from app.services.valuation.models import (
    Assumptions, Scenario, ValuationInput, ValuationResult, Veto,
)

RATING_SEVERITY = {
    "sell": 0, "reduce": 1, "hold": 2, "buy": 3, "strong-buy": 4,
}

_SCENARIO_GROWTH_DELTA = Decimal("0.03")   # +/- on the base growth
_SCENARIO_PROBS = {
    "optimistic": Decimal("0.25"),
    "neutral": Decimal("0.50"),
    "pessimistic": Decimal("0.25"),
}


def _safe_dcf(vi, growth_rates, a) -> Decimal | None:
    try:
        return dcf(vi.fcf_base, growth_rates, a.discount_rate,
                   a.terminal_growth, vi.net_debt, vi.shares_outstanding)
    except (ValueError, InvalidOperation, ZeroDivisionError):
        return None


def value(
    vi: ValuationInput,
    overrides: Assumptions | None = None,
    avg_price_by_period: dict[str, Decimal] | None = None,
) -> ValuationResult:
    warnings: list[str] = []
    cur_mult = current_multiples(vi.metrics, vi.current_price)
    hist_mult = None
    if avg_price_by_period and vi.shares_outstanding:
        hist_mult = historical_self_multiples(
            vi.history, vi.shares_outstanding, avg_price_by_period)

    dcf_invalid = (
        vi.fcf_base is None or vi.fcf_base <= 0
        or vi.shares_outstanding is None or vi.shares_outstanding <= 0
    )
    if dcf_invalid:
        warnings.append("DCF skipped: non-positive FCF or missing shares; "
                        "multiples-only (no fabricated fair value)")
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=None,
            multiples=cur_mult, historical_multiples=hist_mult,
            reverse_dcf_implied_growth=None, data_quality="multiples_only",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=warnings,
        )

    a = overrides or build_default_assumptions(vi.history, vi.beta)
    fair_value = _safe_dcf(vi, a.growth_rates, a)
    if fair_value is None:
        warnings.append("DCF computation failed; multiples-only")
        return ValuationResult(
            symbol=vi.symbol, current_price=vi.current_price, fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=a,
            multiples=cur_mult, historical_multiples=hist_mult,
            reverse_dcf_implied_growth=None, data_quality="multiples_only",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=warnings,
        )

    base_g = a.growth_rates[0]
    scenarios: list[Scenario] = []
    for name, gdelta in (("optimistic", _SCENARIO_GROWTH_DELTA),
                         ("neutral", Decimal("0")),
                         ("pessimistic", -_SCENARIO_GROWTH_DELTA)):
        g = base_g + gdelta
        fv = _safe_dcf(vi, [g] * len(a.growth_rates), a)
        if fv is None:
            continue
        scenarios.append(Scenario(name=name, growth=g, discount=a.discount_rate,
                                  fair_value=fv, probability=_SCENARIO_PROBS[name]))

    mos = margin_of_safety(fair_value, vi.current_price)
    try:
        implied = reverse_dcf(vi.current_price, vi.fcf_base, a.discount_rate,
                              a.terminal_growth, vi.net_debt, vi.shares_outstanding,
                              explicit_years=EXPLICIT_YEARS)
    except (ValueError, InvalidOperation):
        implied = None

    result = ValuationResult(
        symbol=vi.symbol, current_price=vi.current_price, fair_value=fair_value,
        margin_of_safety_pct=mos, scenarios=scenarios, assumptions_used=a,
        multiples=cur_mult, historical_multiples=hist_mult,
        reverse_dcf_implied_growth=implied, data_quality="full",
        veto=Veto(triggered=False, reason=None, rating_cap=None), warnings=warnings,
    )
    result.veto = _compute_veto(vi, result)
    return result


def _compute_veto(vi: ValuationInput, result: ValuationResult) -> Veto:
    # (a) grossly overvalued by DCF
    if result.margin_of_safety_pct is not None and result.margin_of_safety_pct <= Decimal("-0.50"):
        return Veto(triggered=True, rating_cap="hold",
                    reason=f"price >= 2x DCF fair value "
                           f"(margin of safety {result.margin_of_safety_pct:.2f})")
    # (b) reverse-DCF implies implausible growth
    base_g = derive_growth(vi.history)
    if (result.reverse_dcf_implied_growth is not None and base_g > 0
            and result.reverse_dcf_implied_growth > Decimal("2.5") * base_g):
        return Veto(triggered=True, rating_cap="hold",
                    reason=f"price implies {result.reverse_dcf_implied_growth:.1%} growth, "
                           f">2.5x historical {base_g:.1%}")
    return Veto(triggered=False, reason=None, rating_cap=None)


def _cap_rating(rating: str, cap: str) -> str:
    if rating not in RATING_SEVERITY or cap not in RATING_SEVERITY:
        return rating
    return cap if RATING_SEVERITY[rating] > RATING_SEVERITY[cap] else rating


def apply_veto(rating: str, result: ValuationResult) -> tuple[str, Veto]:
    # multiples-only PS>30 veto (computed here since it needs no DCF)
    veto = result.veto
    if (not veto.triggered and result.data_quality == "multiples_only"
            and result.multiples and result.multiples.ps is not None
            and result.multiples.ps > Decimal("30")):
        veto = Veto(triggered=True, rating_cap="hold",
                    reason=f"no positive FCF and P/S {result.multiples.ps:.1f} > 30x")
    if not veto.triggered or veto.rating_cap is None:
        return rating, veto
    return _cap_rating(rating, veto.rating_cap), veto
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_compose.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Run the whole valuation suite + commit**

Run: `cd apps/api && uv run pytest tests/services/valuation -v`
Expected: PASS (all tasks 1–6 green)

```bash
git add apps/api/app/services/valuation/compose.py apps/api/tests/services/valuation/test_compose.py
git commit -m "feat(valuation): compose value() orchestrator and soft-veto rule"
```

---

## Phase B — Data route + API endpoint + chat surface

### Task 7: Web internal route `valuation-inputs`

**Files:**
- Create: `apps/web/server/api/internal/yahoo/valuation-inputs.get.ts`
- Test: `apps/web/server/api/internal/yahoo/__tests__/valuation-inputs.test.ts` (mirror the dir convention used by existing internal-route tests — if tests live elsewhere, follow that location)

**Interfaces:**
- Produces: `GET /api/internal/yahoo/valuation-inputs?symbol=SYM` → `{ symbol, metrics: FinancialMetrics, history: HistoricalPeriod[], dailyBars: DailyBar[] }`. Reuses `getFinancialMetrics`, `getHistorical(symbol, 6)`, `getDailyBars(symbol, 252)` from `apps/web/server/lib/yahoo.ts`. Bearer-guarded.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/server/api/internal/yahoo/__tests__/valuation-inputs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../lib/yahoo', () => ({
  getFinancialMetrics: vi.fn(async () => ({ symbol: 'AAPL', market_cap: 1, beta: 1.2 })),
  getHistorical: vi.fn(async () => [{ period: '2024', fcf: 100 }]),
  getDailyBars: vi.fn(async () => [{ time: '2024-01-02', close: 180 }]),
}))
vi.mock('../../_guard', () => ({ requireInternalBearer: vi.fn() }))

const handler = (await import('../valuation-inputs.get')).default

function makeEvent(symbol?: string) {
  return { node: { req: { url: `/x?symbol=${symbol ?? ''}` } }, context: {} } as any
}

describe('valuation-inputs route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns metrics, history, dailyBars for a symbol', async () => {
    // getQuery reads from the event; stub via h3 helper used in the handler
    const res = await handler(makeEvent('AAPL'))
    expect(res.symbol).toBe('AAPL')
    expect(res.metrics).toBeTruthy()
    expect(Array.isArray(res.history)).toBe(true)
    expect(Array.isArray(res.dailyBars)).toBe(true)
  })
})
```

Note: match the exact mocking style of the existing internal-route tests (how they stub `getQuery`/`requireInternalBearer`). Inspect a sibling test (e.g. for `daily-bars` or `fundamentals`) first and copy its harness; the snippet above is the intent, adapt the event/`getQuery` stubbing to the repo's established pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run server/api/internal/yahoo/__tests__/valuation-inputs.test.ts`
Expected: FAIL — cannot find module `../valuation-inputs.get`

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/server/api/internal/yahoo/valuation-inputs.get.ts
import { createError, defineEventHandler, getQuery } from 'h3'
import { getFinancialMetrics, getHistorical, getDailyBars } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const [metrics, history, dailyBars] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 6),
    getDailyBars(symbol, 252),
  ])
  return { symbol, metrics, history, dailyBars }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run server/api/internal/yahoo/__tests__/valuation-inputs.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx nuxi typecheck`

```bash
git add apps/web/server/api/internal/yahoo/valuation-inputs.get.ts apps/web/server/api/internal/yahoo/__tests__/valuation-inputs.test.ts
git commit -m "feat(web): add internal valuation-inputs route (metrics+history+bars)"
```

---

### Task 8: API fetcher — map internal route → `ValuationInput`

**Files:**
- Create: `apps/api/app/services/valuation/fetch.py`
- Test: `apps/api/tests/services/valuation/test_fetch.py`

**Interfaces:**
- Consumes: `_internal_get` pattern from `apps/api/app/services/agents/toolkit.py` (HTTP to `WEB_INTERNAL_BASE_URL` with `INTERNAL_BEARER`). Reuse that helper — import `from app.services.agents.toolkit import _internal_get` rather than duplicating.
- Produces:
  - `to_valuation_input(symbol: str, payload: dict) -> ValuationInput` — pure mapper (testable without HTTP). Computes `fcf_base` from `metrics.free_cash_flow` (fallback: newest `history[].fcf`); `net_debt` from newest history `total_debt` minus cash if available else `total_debt or 0`; `avg_price_by_period` by bucketing `dailyBars` per calendar year and averaging close.
  - `fetch_valuation_input(symbol: str) -> ValuationInput` — calls `_internal_get("/api/internal/yahoo/valuation-inputs", {"symbol": symbol})` then `to_valuation_input`.
  - `avg_close_by_year(daily_bars: list[dict]) -> dict[str, Decimal]`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_fetch.py
from decimal import Decimal
from app.services.valuation.fetch import to_valuation_input, avg_close_by_year

D = Decimal


def test_avg_close_by_year_buckets_and_averages():
    bars = [
        {"time": "2023-01-02", "close": 10},
        {"time": "2023-06-02", "close": 20},
        {"time": "2024-01-02", "close": 40},
    ]
    out = avg_close_by_year(bars)
    assert out["2023"] == D("15")
    assert out["2024"] == D("40")


def test_to_valuation_input_uses_metrics_fcf_and_maps_history():
    payload = {
        "symbol": "AAPL",
        "metrics": {"market_cap": 1000, "free_cash_flow": 100, "shares_outstanding": 10,
                    "beta": 1.2, "ps_ratio": 5},
        "history": [{"period": "2024", "fcf": 100, "revenue": 500, "net_income": 80,
                     "total_debt": 50}],
        "dailyBars": [{"time": "2024-01-02", "close": 100}],
    }
    vi = to_valuation_input("AAPL", payload)
    assert vi.symbol == "AAPL"
    assert vi.fcf_base == D("100")
    assert vi.shares_outstanding == D("10")
    assert vi.current_price == D("100")   # newest close
    assert vi.beta == D("1.2")


def test_to_valuation_input_missing_data_degrades():
    vi = to_valuation_input("X", {"symbol": "X", "metrics": {}, "history": [], "dailyBars": []})
    assert vi.fcf_base is None
    assert vi.shares_outstanding is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_fetch.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/fetch.py
from __future__ import annotations

from decimal import Decimal, InvalidOperation

from app.services.agents.toolkit import _internal_get
from app.services.valuation.models import HistoryPeriod, Metrics, ValuationInput


def _dec(v) -> Decimal | None:
    if v is None:
        return None
    try:
        return Decimal(str(v))
    except (InvalidOperation, ValueError):
        return None


def avg_close_by_year(daily_bars: list[dict]) -> dict[str, Decimal]:
    sums: dict[str, Decimal] = {}
    counts: dict[str, int] = {}
    for b in daily_bars:
        t = b.get("time") or b.get("date")
        close = _dec(b.get("close"))
        if not t or close is None:
            continue
        year = str(t)[:4]
        sums[year] = sums.get(year, Decimal("0")) + close
        counts[year] = counts.get(year, 0) + 1
    return {y: (sums[y] / counts[y]) for y in sums}


def _history(rows: list[dict]) -> list[HistoryPeriod]:
    return [
        HistoryPeriod(
            period=str(r.get("period") or ""),
            revenue=_dec(r.get("revenue")),
            net_income=_dec(r.get("net_income")),
            fcf=_dec(r.get("fcf")),
            total_debt=_dec(r.get("total_debt")),
            shareholders_equity=_dec(r.get("shareholders_equity")),
        )
        for r in rows
    ]


def _metrics(m: dict) -> Metrics:
    return Metrics(
        market_cap=_dec(m.get("market_cap")),
        pe_ratio=_dec(m.get("pe_ratio")),
        pb_ratio=_dec(m.get("pb_ratio")),
        ps_ratio=_dec(m.get("ps_ratio")),
        eps=_dec(m.get("eps")),
        free_cash_flow=_dec(m.get("free_cash_flow")),
        shares_outstanding=_dec(m.get("shares_outstanding")),
        beta=_dec(m.get("beta")),
    )


def to_valuation_input(symbol: str, payload: dict) -> ValuationInput:
    metrics = _metrics(payload.get("metrics") or {})
    history = _history(payload.get("history") or [])
    bars = payload.get("dailyBars") or []
    newest_close = _dec(bars[-1].get("close")) if bars else None
    current_price = newest_close or Decimal("0")

    fcf_base = metrics.free_cash_flow
    if fcf_base is None and history and history[0].fcf is not None:
        fcf_base = history[0].fcf

    net_debt = history[0].total_debt if history else None
    if net_debt is None:
        net_debt = Decimal("0")

    shares = metrics.shares_outstanding

    return ValuationInput(
        symbol=symbol, current_price=current_price, fcf_base=fcf_base,
        net_debt=net_debt, shares_outstanding=shares, beta=metrics.beta,
        history=history, metrics=metrics,
    )


async def fetch_valuation_input(symbol: str) -> ValuationInput:
    payload = await _internal_get("/api/internal/yahoo/valuation-inputs", {"symbol": symbol})
    return to_valuation_input(symbol, payload)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_fetch.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/fetch.py apps/api/tests/services/valuation/test_fetch.py
git commit -m "feat(valuation): add internal-route fetcher and ValuationInput mapper"
```

---

### Task 9: FastAPI `GET /valuation` router

**Files:**
- Create: `apps/api/app/routers/valuation.py`
- Modify: `apps/api/app/main.py:11-18` (import) and `apps/api/app/main.py:256-261` (register)
- Test: `apps/api/tests/routers/test_valuation.py`

**Interfaces:**
- Consumes: `fetch_valuation_input` (Task 8), `value` (Task 6), `avg_close_by_year`.
- Produces: `GET /valuation?symbol=SYM` → `ValuationResult` JSON. On fetch failure returns an `unavailable` `ValuationResult` (200, never 500) so the chat tool degrades gracefully.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/routers/test_valuation.py
from decimal import Decimal
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

D = Decimal


@pytest.mark.asyncio
async def test_valuation_endpoint_returns_result(monkeypatch):
    async def fake_fetch(symbol):
        return ValuationInput(symbol=symbol, current_price=D("100"), fcf_base=D("100"),
                              net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.2"),
                              history=[HistoryPeriod(period="2024", fcf=D("100")),
                                       HistoryPeriod(period="2021", fcf=D("80"))],
                              metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", fake_fetch)

    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.get("/valuation", params={"symbol": "AAPL"})
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "AAPL"
    assert body["data_quality"] in {"full", "multiples_only"}


@pytest.mark.asyncio
async def test_valuation_endpoint_degrades_on_fetch_error(monkeypatch):
    async def boom(symbol):
        raise RuntimeError("yahoo down")
    monkeypatch.setattr("app.routers.valuation.fetch_valuation_input", boom)
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as ac:
        r = await ac.get("/valuation", params={"symbol": "AAPL"})
    assert r.status_code == 200
    assert r.json()["data_quality"] == "unavailable"
```

(If the api test suite already has an httpx/ASGI fixture, reuse it instead of constructing the client inline — check `apps/api/tests/conftest.py` first.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/routers/test_valuation.py -v`
Expected: FAIL — `ModuleNotFoundError: app.routers.valuation`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/routers/valuation.py
from __future__ import annotations

from fastapi import APIRouter, Query

from app.services.valuation.compose import value
from app.services.valuation.fetch import avg_close_by_year, fetch_valuation_input
from app.services.valuation.models import ValuationResult, Veto

router = APIRouter(tags=["valuation"])


@router.get("/valuation", response_model=ValuationResult)
async def get_valuation(symbol: str = Query(..., min_length=1)) -> ValuationResult:
    from decimal import Decimal
    try:
        vi = await fetch_valuation_input(symbol)
    except Exception:  # noqa: BLE001 - data-source outage degrades, never 500s
        return ValuationResult(
            symbol=symbol, current_price=Decimal("0"), fair_value=None,
            margin_of_safety_pct=None, scenarios=[], assumptions_used=None,
            multiples=None, historical_multiples=None,
            reverse_dcf_implied_growth=None, data_quality="unavailable",
            veto=Veto(triggered=False, reason=None, rating_cap=None),
            warnings=["valuation inputs unavailable"],
        )
    # avg price per year for historical-self multiples (re-fetch-free: use the
    # bars already mapped is not retained on vi, so recompute here is skipped;
    # historical multiples are best-effort and may be None).
    return value(vi)
```

Register in `main.py` — add `valuation` to the import tuple (line ~11-18) and `app.include_router(valuation.router)` (after `agents` at line ~261):

```python
from app.routers import (
    agents,
    algo,
    health,
    quote,
    trade,
    valuation,
    watchlist,
)
# ...
    app.include_router(agents.router)
    app.include_router(valuation.router)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/routers/test_valuation.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/routers/valuation.py apps/api/app/main.py apps/api/tests/routers/test_valuation.py
git commit -m "feat(api): add GET /valuation endpoint with graceful degradation"
```

---

### Task 10: Web proxy `/api/research/valuation`

**Files:**
- Create: `apps/web/server/api/research/valuation.get.ts`
- Test: `apps/web/server/api/research/__tests__/valuation.test.ts` (follow existing research-route test convention)

**Interfaces:**
- Consumes: api `GET /valuation`; the established api base URL + auth pattern used by sibling research proxies (inspect `agent-runs.get.ts` / `intelligence.get.ts` to copy how they call the api — base URL env var, bearer, `$fetch`/`httpClient`). Resolve the symbol first via `resolveSymbol` (same hard-gate pattern as `agents-run.post.ts`).
- Produces: `GET /api/research/valuation?symbol=SYM` → forwards the api `ValuationResult`. 422 when symbol can't be resolved.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/server/api/research/__tests__/valuation.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/yahoo', () => ({
  resolveSymbol: vi.fn(async () => ({ status: 'resolved', symbol: 'AAPL', name: 'Apple' })),
}))
const fetchMock = vi.fn(async () => ({ symbol: 'AAPL', data_quality: 'full', fair_value: '150' }))
vi.stubGlobal('$fetch', fetchMock)

const handler = (await import('../valuation.get')).default

describe('research/valuation proxy', () => {
  beforeEach(() => vi.clearAllMocks())
  it('resolves then forwards the api result', async () => {
    const event = { node: { req: { url: '/x?symbol=AAPL' } }, context: {} } as any
    const res = await handler(event)
    expect(res.symbol).toBe('AAPL')
    expect(res.data_quality).toBe('full')
  })
})
```

Adapt the api-call mock to the repo's actual client (the snippet assumes `$fetch`; if sibling proxies use a shared `httpClient`, mock that instead).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run server/api/research/__tests__/valuation.test.ts`
Expected: FAIL — cannot find `../valuation.get`

- [ ] **Step 3: Write minimal implementation** (mirror `agent-runs.get.ts` for the api-call mechanics)

```typescript
// apps/web/server/api/research/valuation.get.ts
import { createError, defineEventHandler, getQuery } from 'h3'
import { resolveSymbol } from '../../lib/yahoo'
// NOTE: import the api base URL + auth helper the sibling proxies use.

export default defineEventHandler(async (event) => {
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const resolution = await resolveSymbol(symbol)
  if (resolution.status !== 'resolved') {
    throw createError({ statusCode: 422, statusMessage: 'symbol could not be uniquely resolved — pick from search' })
  }
  const apiBase = process.env.API_INTERNAL_BASE_URL // use the same env the other proxies read
  return await $fetch(`${apiBase}/valuation`, { query: { symbol: resolution.symbol } })
})
```

Replace `apiBase`/`$fetch` with the exact mechanism the neighboring research proxies use (copy from `agent-runs.get.ts`). Do not invent a new client.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run server/api/research/__tests__/valuation.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx nuxi typecheck`

```bash
git add apps/web/server/api/research/valuation.get.ts apps/web/server/api/research/__tests__/valuation.test.ts
git commit -m "feat(web): add research/valuation proxy with symbol resolution gate"
```

---

### Task 11: `value_stock` chat tool

**Files:**
- Modify: `apps/web/server/llm/tools.ts` (add tool inside `makeTools`, near `portfolio_mpt_analysis` ~line 214)
- Modify: `apps/web/server/llm/chat-context.ts` (`buildSystemPrompt` tool catalog — add a one-line description of `value_stock`)
- Test: `apps/web/server/llm/__tests__/tools-value-stock.test.ts` (follow existing `tools.ts` test convention; if none, place beside existing llm tests)

**Interfaces:**
- Consumes: `/api/research/valuation` proxy (Task 10) via the same self-fetch pattern other chat tools use — and it MUST forward the `cookie: session=...` header (chat self-fetch auth rule). Inspect how `portfolio_mpt_analysis` / `agents_debate` self-fetch and copy that exact cookie-forwarding.
- Produces: tool `value_stock` with `inputSchema: z.object({ symbol: z.string() })`, returning the `ValuationResult` JSON for the UI to render.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/server/llm/__tests__/tools-value-stock.test.ts
import { describe, it, expect, vi } from 'vitest'
import { makeTools } from '../tools'

describe('value_stock tool', () => {
  it('is registered and calls the valuation proxy', async () => {
    const client = {} as any
    const tools = makeTools(client, { /* mimic the arg sibling tools receive */ } as any)
    expect(tools['value_stock']).toBeDefined()
    // execute path: stub the self-fetch used inside and assert it hits /api/research/valuation
  })
})
```

Flesh out the execute assertion to match how the other tools are unit-tested in this repo (inspect an existing `makeTools` test). The non-negotiable assertions: the tool key `value_stock` exists, and its `execute` calls the `/api/research/valuation` proxy forwarding the session cookie.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run server/llm/__tests__/tools-value-stock.test.ts`
Expected: FAIL — `tools['value_stock']` is undefined

- [ ] **Step 3: Write minimal implementation** (inside `makeTools`, copying the self-fetch+cookie pattern of `portfolio_mpt_analysis`)

```typescript
    'value_stock': tool({
      description:
        'Compute a deterministic DCF valuation for a stock: fair value, '
        + 'margin of safety, 3 scenarios (optimistic/neutral/pessimistic), '
        + 'reverse-DCF implied growth, and multiples. Use when the user asks '
        + 'whether a stock is cheap/expensive or what it is worth.',
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => {
        // self-fetch the proxy, forwarding the session cookie exactly as the
        // sibling tools do (see portfolio_mpt_analysis):
        return await selfFetch(`/api/research/valuation`, { query: { symbol } })
      },
    }),
```

Replace `selfFetch(...)` with the repo's actual self-fetch helper and cookie-forwarding (copy verbatim from `portfolio_mpt_analysis`). Add the one-line `value_stock` entry to the tool catalog in `chat-context.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run server/llm/__tests__/tools-value-stock.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && npx nuxi typecheck`

```bash
git add apps/web/server/llm/tools.ts apps/web/server/llm/chat-context.ts apps/web/server/llm/__tests__/tools-value-stock.test.ts
git commit -m "feat(web): add value_stock chat tool backed by the valuation engine"
```

---

### Task 12: `ValuationCard.vue` renderer + wire into chat tool rendering

**Files:**
- Create: `apps/web/app/components/chat/ValuationCard.vue`
- Modify: the chat message renderer that maps tool name → card component (find where `PortfolioMptCard` / `AgentsDebateCard` are dispatched; add a `value_stock` → `ValuationCard` branch)
- Test: `apps/web/app/components/chat/__tests__/ValuationCard.test.ts` (Vue Test Utils — follow existing card-test convention; if cards aren't unit-tested in this repo, skip the test file and rely on typecheck, noting that here)

**Interfaces:**
- Consumes: `ValuationResult` shape (import the type from the server types so the card and API stay in sync — do NOT redefine the shape inline).
- Produces: a card showing fair value vs current price, margin-of-safety %, the 3 scenario fair values, reverse-DCF implied growth, multiples, `data_quality` badge, and a prominent veto badge when `veto.triggered`.

- [ ] **Step 1: Write the failing test** (only if cards are unit-tested here)

```typescript
// apps/web/app/components/chat/__tests__/ValuationCard.test.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ValuationCard from '../ValuationCard.vue'

describe('ValuationCard', () => {
  it('shows margin of safety and a veto badge when triggered', () => {
    const wrapper = mount(ValuationCard, {
      props: {
        result: {
          symbol: 'AAPL', current_price: '1000', fair_value: '150',
          margin_of_safety_pct: '-0.85', scenarios: [], multiples: null,
          historical_multiples: null, reverse_dcf_implied_growth: '0.4',
          data_quality: 'full', assumptions_used: null,
          veto: { triggered: true, reason: 'price >= 2x DCF fair value', rating_cap: 'hold' },
          warnings: [],
        },
      },
    })
    expect(wrapper.text()).toContain('AAPL')
    expect(wrapper.text().toLowerCase()).toContain('veto')
  })

  it('shows an empty state when data_quality is unavailable', () => {
    const wrapper = mount(ValuationCard, {
      props: { result: { symbol: 'X', data_quality: 'unavailable', scenarios: [],
        veto: { triggered: false, reason: null, rating_cap: null }, warnings: ['n/a'],
        current_price: '0', fair_value: null, margin_of_safety_pct: null,
        multiples: null, historical_multiples: null, reverse_dcf_implied_growth: null,
        assumptions_used: null } as any },
    })
    expect(wrapper.text().toLowerCase()).toContain('unavailable')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run app/components/chat/__tests__/ValuationCard.test.ts`
Expected: FAIL — cannot find `../ValuationCard.vue`

- [ ] **Step 3: Write minimal implementation**

Build `ValuationCard.vue` following the existing card components' structure (props, `<script setup lang="ts">`, scoped styles — and remember `:deep()` not `:global()` for scoped child selectors). Render: header (`symbol`, `data_quality` badge), fair value vs price with MoS %, a small scenario table (name / growth / fair value), reverse-DCF implied growth, multiples block, and a veto banner when `result.veto.triggered` showing `result.veto.reason` and the `rating_cap`. Unavailable/multiples-only states show an explanatory line from `warnings`. Then add the `value_stock → ValuationCard` branch in the chat tool-card dispatcher (mirror the existing `PortfolioMptCard` registration).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run app/components/chat/__tests__/ValuationCard.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, rebuild, manual check, commit**

Run: `cd apps/web && npx nuxi typecheck`
Run: `docker compose up -d --build web`
Manual: in chat, ask "what is AAPL worth?" → confirm a ValuationCard renders with fair value + scenarios.

```bash
git add apps/web/app/components/chat/ValuationCard.vue apps/web/app/components/chat/__tests__/ValuationCard.test.ts <dispatcher file>
git commit -m "feat(web): render valuation results as a ValuationCard"
```

---

## Phase C — Pipeline integration + soft veto

### Task 13: Valuation summary formatter (for judge-context injection)

**Files:**
- Create: `apps/api/app/services/valuation/summary.py`
- Test: `apps/api/tests/services/valuation/test_summary.py`

**Interfaces:**
- Produces: `format_valuation_for_agents(result: ValuationResult) -> str` — compact markdown the judges can read: fair value, MoS, the 3 scenarios, reverse-DCF implied growth vs historical, and an explicit veto line ("VALUATION VETO: rating capped at HOLD — <reason>") when triggered. States "valuation unavailable" cleanly when `data_quality == "unavailable"`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/valuation/test_summary.py
from decimal import Decimal
from app.services.valuation.summary import format_valuation_for_agents
from app.services.valuation.models import ValuationResult, Veto

D = Decimal


def test_summary_includes_fair_value_and_veto():
    res = ValuationResult(
        symbol="X", current_price=D("1000"), fair_value=D("150"),
        margin_of_safety_pct=D("-0.85"), scenarios=[], assumptions_used=None,
        multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=D("0.4"), data_quality="full",
        veto=Veto(triggered=True, reason="price >= 2x DCF fair value", rating_cap="hold"),
        warnings=[])
    out = format_valuation_for_agents(res)
    assert "150" in out
    assert "VETO" in out.upper()


def test_summary_handles_unavailable():
    res = ValuationResult(
        symbol="X", current_price=D("0"), fair_value=None, margin_of_safety_pct=None,
        scenarios=[], assumptions_used=None, multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=None, data_quality="unavailable",
        veto=Veto(triggered=False, reason=None, rating_cap=None), warnings=["n/a"])
    out = format_valuation_for_agents(res)
    assert "unavailable" in out.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_summary.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/services/valuation/summary.py
from __future__ import annotations

from app.services.valuation.models import ValuationResult


def format_valuation_for_agents(result: ValuationResult) -> str:
    if result.data_quality == "unavailable":
        return "## Deterministic Valuation\nValuation unavailable (data could not be retrieved)."
    lines = ["## Deterministic Valuation (DCF, computed — do not recompute by hand)"]
    if result.fair_value is not None:
        lines.append(f"- Fair value/share: {result.fair_value:.2f} "
                     f"(current price {result.current_price:.2f})")
    if result.margin_of_safety_pct is not None:
        lines.append(f"- Margin of safety: {result.margin_of_safety_pct:.1%}")
    if result.reverse_dcf_implied_growth is not None:
        lines.append(f"- Reverse-DCF implied growth (priced in): "
                     f"{result.reverse_dcf_implied_growth:.1%}")
    for s in result.scenarios:
        lines.append(f"  - {s.name}: growth {s.growth:.1%} → fair value {s.fair_value:.2f}")
    if result.multiples and result.multiples.ps is not None:
        lines.append(f"- P/S: {result.multiples.ps:.1f}")
    if result.veto.triggered:
        lines.append(f"\n**VALUATION VETO: rating capped at {str(result.veto.rating_cap).upper()} "
                     f"— {result.veto.reason}.** You may argue against this in your rationale, "
                     f"but the cap will be applied and your dissent logged.")
    for w in result.warnings:
        lines.append(f"- _note: {w}_")
    return "\n".join(lines)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/valuation/test_summary.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/valuation/summary.py apps/api/tests/services/valuation/test_summary.py
git commit -m "feat(valuation): add agent-facing valuation summary formatter"
```

---

### Task 14: Compute valuation per run + inject into judge memory

**Files:**
- Modify: `apps/api/app/services/agents/graph.py` (`run_graph`, ~line 790-833 — compute valuation before the stream loop and seed it)
- Test: `apps/api/tests/services/agents/test_run_graph_valuation.py`

**Interfaces:**
- Consumes: `fetch_valuation_input` + `value` + `format_valuation_for_agents`; the existing `_seed_all_memories(graph, symbol, memory_by_role)` seeding mechanism.
- Produces: `run_graph` gains an injected valuation. Add a module-level helper `async def _compute_run_valuation(symbol: str) -> tuple[ValuationResult | None, str]` returning `(result, summary_markdown)` — fail-soft to `(None, "")` on any error so a valuation outage never aborts a run. The summary is appended to the `invest_judge` and `risk_manager` memory slices before seeding so it lands in `{past_memory_str}`. Store the `ValuationResult` on a run-scoped attribute the decision step can read (Task 15).

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/agents/test_run_graph_valuation.py
import pytest
from app.services.agents.graph import _compute_run_valuation


@pytest.mark.asyncio
async def test_compute_run_valuation_failsoft(monkeypatch):
    async def boom(symbol):
        raise RuntimeError("down")
    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", boom)
    result, summary = await _compute_run_valuation("AAPL")
    assert result is None
    assert summary == ""


@pytest.mark.asyncio
async def test_compute_run_valuation_returns_summary(monkeypatch):
    from decimal import Decimal as D
    from app.services.valuation.models import ValuationInput, Metrics, HistoryPeriod

    async def fake(symbol):
        return ValuationInput(symbol=symbol, current_price=D("100"), fcf_base=D("100"),
                              net_debt=D("0"), shares_outstanding=D("10"), beta=D("1.2"),
                              history=[HistoryPeriod(period="2024", fcf=D("100")),
                                       HistoryPeriod(period="2021", fcf=D("80"))],
                              metrics=Metrics(free_cash_flow=D("100"), shares_outstanding=D("10")))
    monkeypatch.setattr("app.services.agents.graph.fetch_valuation_input", fake)
    result, summary = await _compute_run_valuation("AAPL")
    assert result is not None
    assert "Valuation" in summary
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/agents/test_run_graph_valuation.py -v`
Expected: FAIL — `cannot import name '_compute_run_valuation'`

- [ ] **Step 3: Write minimal implementation**

Add imports at the top of `graph.py`:

```python
from app.services.valuation.compose import apply_veto, value
from app.services.valuation.fetch import fetch_valuation_input
from app.services.valuation.models import ValuationResult
from app.services.valuation.summary import format_valuation_for_agents
```

Add the helper near the other module-level helpers:

```python
async def _compute_run_valuation(symbol: str) -> tuple[ValuationResult | None, str]:
    """Compute the deterministic valuation for this run, fail-soft.

    Returns (result, agent-facing summary markdown). Any data/compute error
    returns (None, "") so a valuation outage never aborts the agent run."""
    try:
        vi = await fetch_valuation_input(symbol)
        result = value(vi)
        return result, format_valuation_for_agents(result)
    except Exception as e:  # noqa: BLE001 - valuation is best-effort context
        print(f"[agents] valuation skipped for {symbol}: {e}")
        return None, ""
```

In `run_graph`, after the `memory_by_role` seeding block (~line 830-833), compute and inject:

```python
    run_valuation, valuation_summary = await _compute_run_valuation(symbol)
    if valuation_summary:
        injected = {
            "invest_judge": [{"text": valuation_summary, "rating": "valuation",
                              "outcome": "context", "trade_date": trade_date.isoformat()}],
            "risk_manager": [{"text": valuation_summary, "rating": "valuation",
                              "outcome": "context", "trade_date": trade_date.isoformat()}],
        }
        # merge with any role memory already seeded, then re-seed those two roles
        _seed_all_memories(graph, symbol, injected)
```

The exact memory-entry dict shape must match what `_seed_all_memories` / `_recall_memory_by_role` expect — inspect `memory.py` and the existing `_format_*memory` helpers (lines ~660-690) and match their keys precisely. If `_seed_all_memories` overwrites rather than appends, fold the valuation entry into the `memory_by_role` dict *before* the original seeding call instead of calling it twice.

Expose `run_valuation` so Task 15 can read it: attach it to the graph or thread it through. Simplest: have `run_graph` close over `run_valuation` and pass it into `_extract_decision` (Task 15 changes that signature).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/agents/test_run_graph_valuation.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/agents/graph.py apps/api/tests/services/agents/test_run_graph_valuation.py
git commit -m "feat(agents): compute per-run valuation and inject into judge context"
```

---

### Task 15: Apply soft veto to the decision + emit `valuation-veto` event

**Files:**
- Modify: `apps/api/app/services/agents/graph.py` (`_extract_decision` ~line 620-645, and its call site in `run_graph` ~line 888-890)
- Modify: `apps/api/app/services/agents/streaming.py` (translate a `valuation_veto` value into a `valuation-veto` wire event)
- Modify: `apps/web/types/agents.ts` (add the `valuation-veto` event variant to the `AgentEvent` union) and `AgentTimeline.vue` (render it)
- Test: `apps/api/tests/services/agents/test_decision_veto.py`

**Interfaces:**
- Consumes: `apply_veto(rating, result)` (Task 6), `run_valuation` (Task 14).
- Produces: `_extract_decision(prev, curr, valuation: ValuationResult | None = None) -> dict | None` — when a decision is produced and `valuation` has a triggered veto, it sets `decision["rating"]` to the capped rating, preserves the original under `decision["original_rating"]`, and adds `decision["veto"] = {reason, rating_cap}`. `run_graph` emits an extra `{"type": "valuation-veto", ...}` value (via `values["valuation_veto"]`) when the cap actually changed the rating.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/services/agents/test_decision_veto.py
from decimal import Decimal as D
from app.services.agents.graph import _extract_decision
from app.services.valuation.models import ValuationResult, Veto


def _overvalued_result():
    return ValuationResult(
        symbol="X", current_price=D("1000"), fair_value=D("150"),
        margin_of_safety_pct=D("-0.85"), scenarios=[], assumptions_used=None,
        multiples=None, historical_multiples=None,
        reverse_dcf_implied_growth=D("0.4"), data_quality="full",
        veto=Veto(triggered=True, reason="price >= 2x DCF fair value", rating_cap="hold"),
        warnings=[])


def test_decision_capped_by_veto_preserves_original():
    prev = {"final_trade_decision": ""}
    curr = {"final_trade_decision": "FINAL TRANSACTION PROPOSAL: **BUY**"}
    dec = _extract_decision(prev, curr, valuation=_overvalued_result())
    assert dec["rating"] == "hold"
    assert dec["original_rating"] == "buy"
    assert dec["veto"]["rating_cap"] == "hold"


def test_decision_unchanged_without_veto():
    prev = {"final_trade_decision": ""}
    curr = {"final_trade_decision": "FINAL TRANSACTION PROPOSAL: **BUY**"}
    dec = _extract_decision(prev, curr, valuation=None)
    assert dec["rating"] == "buy"
    assert "original_rating" not in dec
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && uv run pytest tests/services/agents/test_decision_veto.py -v`
Expected: FAIL — `_extract_decision() got an unexpected keyword argument 'valuation'`

- [ ] **Step 3: Write minimal implementation**

Modify `_extract_decision`:

```python
def _extract_decision(prev: dict, curr: dict, valuation: "ValuationResult | None" = None) -> dict | None:
    pdec = prev.get("final_trade_decision") or ""
    cdec = curr.get("final_trade_decision") or ""
    if not cdec or cdec == pdec:
        return None
    rating = _parse_rating(cdec)
    decision = {
        "rating": rating,
        "confidence": _parse_confidence(cdec),
        "rationale": cdec,
    }
    if valuation is not None and valuation.veto.triggered:
        effective, veto = apply_veto(rating, valuation)
        if effective != rating:
            decision["original_rating"] = rating
            decision["rating"] = effective
            decision["veto"] = {"reason": veto.reason, "rating_cap": veto.rating_cap}
    return decision
```

Update the call site in `run_graph` (~line 888):

```python
        decision = _extract_decision(prev, curr, valuation=run_valuation)
        if decision:
            values["decision"] = decision
            if decision.get("veto"):
                values["valuation_veto"] = {
                    "original_rating": decision["original_rating"],
                    "effective_rating": decision["rating"],
                    **decision["veto"],
                }
```

In `streaming.py`, after the `decision` translation (~line 113-119), add:

```python
        veto = values.get("valuation_veto")
        if veto:
            yield {"type": "valuation-veto", **veto}
```

In `apps/web/types/agents.ts`, add to the `AgentEvent` union:

```typescript
  | { type: 'valuation-veto'; original_rating: string; effective_rating: string; reason: string; rating_cap: string }
```

In `AgentTimeline.vue`, add a branch rendering a distinct "Valuation veto applied" banner (original → effective rating + reason) wherever the event stream is rendered.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && uv run pytest tests/services/agents/test_decision_veto.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Full suite, typecheck, rebuild, commit**

Run: `cd apps/api && uv run pytest -q`
Run: `cd apps/web && npx nuxi typecheck && npx vitest run`
Run: `docker compose up -d --build api web`
Manual: run a deep analysis on a richly-overvalued ticker → confirm the verdict shows the capped rating + a valuation-veto banner in the timeline, with the agent's original rationale preserved.

```bash
git add apps/api/app/services/agents/graph.py apps/api/app/services/agents/streaming.py apps/web/types/agents.ts apps/web/app/components/research/AgentTimeline.vue apps/api/tests/services/agents/test_decision_veto.py
git commit -m "feat(agents): apply soft valuation veto and emit valuation-veto event"
```

---

## Self-Review

**Spec coverage:**
- Deterministic core (DCF, reverse-DCF, 3-scenario, MoS, current+historical multiples) → Tasks 2, 3, 6 ✓
- Hybrid auto-derived + overridable assumptions (CAPM, FCF-CAGR) → Task 4; override param on `value()` → Task 6 ✓
- Cross-source >1% + market-cap verify → Task 5 ✓
- Never-fabricate-on-sparse-data → Task 6 (`multiples_only`/`unavailable` paths), tested ✓
- Structured `ValuationResult` contract → Task 1 ✓
- Data route (stop discarding 5yr history) → Task 7; fetcher/mapper → Task 8 ✓
- Chat surface (endpoint, proxy, tool, card) → Tasks 9–12 ✓
- Pipeline injection into judges → Tasks 13–14 ✓
- Soft veto (cap applied, original + reason surfaced, event emitted) → Tasks 6, 15 ✓
- v2 deferrals (peer multiples, Benford, full A/B/C subsystem, reflection feedback) → correctly absent ✓

**Placeholder scan:** The Phase B/C web tasks (10, 11, 12, 15 UI) intentionally say "copy the sibling pattern" for repo-specific mechanics (self-fetch helper, api-base env, cookie forwarding, card-dispatcher location, timeline rendering) rather than guess them — these are real, named files to inspect, not vague TODOs. Every core/computational task (1–9, 13, 14) has complete runnable code. The one deliberately-open spec item (exact judge-injection mechanism) is pinned in Task 14 to the existing `_seed_all_memories` channel with a concrete fallback.

**Type consistency:** `ValuationResult`/`Veto`/`Assumptions`/`Scenario`/`Multiples`/`ValuationInput`/`HistoryPeriod`/`Metrics` are defined once (Task 1) and reused verbatim. `value()`, `apply_veto()`, `RATING_SEVERITY`, `derive_growth()`, `fetch_valuation_input()`, `to_valuation_input()`, `format_valuation_for_agents()`, `_compute_run_valuation()`, `_extract_decision(..., valuation=)` signatures match across their definition and call sites.

**Note on overrides path:** `value(vi, overrides=...)` exists for the LLM-override case (Task 6), but no task wires an LLM-supplied override through `get_valuation`/the pipeline in v1 — the engine ships override-ready, baseline auto-derived assumptions are used everywhere in v1. Surfacing LLM overrides end-to-end is a small v1.1 follow-up, intentionally out of these tasks.
