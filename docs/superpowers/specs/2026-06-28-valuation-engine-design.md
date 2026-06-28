# Deterministic Valuation Engine — Design

**Date:** 2026-06-28
**Status:** Approved (design); pending implementation plan
**Author:** JJ + Claude

## Motivation

ai-trader has a strong *engine* (LangGraph TradingAgents pipeline, closed-loop
reflection learning, live Yahoo/moomoo data, structured verdict rendering) but a
shallow *analytical core*: there is **no explicit valuation**. "Valuation" today
is the LLM eyeballing a single-period Yahoo fundamentals JSON blob. The pipeline
emits a `FINAL TRANSACTION PROPOSAL: BUY/SELL/HOLD` with no fair-value estimate,
no margin of safety, and no check on whether the current price already prices in
heroic assumptions.

The reference project `xbtlin/ai-berkshire` is the inverse: deep value-investing
discipline (DCF + 3 scenarios + margin of safety, a deterministic `Decimal` math
tool that the prompt *forbids* the LLM from bypassing, a >1% cross-source
discrepancy flag, "model confidence vs investment certainty" separation) but **no
running system** — it is prompt scaffolding plus one zero-dependency Python CLI,
and its claimed returns (+69% / +66%) are unverified brokerage screenshots, not a
backtest. The *methodology* is the prize, not the numbers.

This project ports ai-berkshire's valuation rigor **into** ai-trader's engine,
backed by ai-trader's real data feeds, structured rendering, and (later) its
reflection loop.

### Key enabling discovery

The 5-year historical series a DCF needs already exists in
`apps/web/server/lib/yahoo.ts` → `getHistorical()` / `fetchHistorical`
(`revenue`, `net_income`, **`fcf`**, `total_debt`, `total_assets`,
`shareholders_equity` per year), alongside `shares_outstanding`, `market_cap`,
`beta`, and current multiples in `FinancialMetrics`. The toolkit currently
**throws this away** — every statement tool in
`apps/api/app/services/agents/toolkit.py` does `del freq, curr_date` and returns
only the latest snapshot, so the agents have never seen a trend. The data is
already there; we only need to stop discarding it.

## Decisions (resolved during brainstorming)

1. **Assumption sourcing — Hybrid.** This *is* ai-berkshire's method: the agent
   proposes scenario inputs, the tool enforces exact `Decimal` 3-scenario math.
   Addition required by ai-trader (which runs autonomously / nightly, unlike
   ai-berkshire's human-in-the-loop flow): the engine **auto-derives sane
   defaults** (FCF-CAGR growth, CAPM discount, 2.5% terminal) as a reproducible
   baseline, which the LLM may override — after which the tool recomputes. Pure
   LLM-proposed assumptions were rejected because the same ticker would value
   differently run-to-run and poison the reflection lessons.
2. **Verdict role — Inform + soft veto.** Valuation is injected into the judges'
   context as a required input. A valuation veto (extreme overvaluation) applies
   a rating cap mechanically, **but the agent's original rating + reasoning and
   the veto reason are both preserved and surfaced** — logged dissent, not a
   silent override.
3. **Surface — Both.** A shared deterministic core exposed as (1) a chat copilot
   tool with a rendered card and (2) an injected input to the LangGraph pipeline.

## Architecture

### Component 1 — Deterministic core (`apps/api/app/services/valuation/`)

Pure-Python, `Decimal`-based (`ROUND_HALF_EVEN`, 28-digit precision, matching
ai-berkshire), zero I/O, fully unit-testable. The library form of ai-berkshire's
`financial_rigor.py`.

- **`models.py`** — pydantic contracts:
  - `Assumptions{ growth_rates: list[Decimal], discount_rate, terminal_growth }`
  - `ValuationInput{ symbol, current_price, fcf_base, net_debt, shares_outstanding, beta, history, metrics }`
  - `Scenario{ name, growth, discount, fair_value, target_price, probability }`
  - `ValuationResult{ symbol, fair_value, current_price, margin_of_safety_pct,
    scenarios[], assumptions_used, multiples, historical_multiples,
    reverse_dcf_implied_growth, data_quality, veto{triggered, reason, rating_cap},
    warnings[] }` — **the structured JSON contract**.
- **`assumptions.py`** — auto-derivation:
  - `derive_growth(history)` — dampened 5yr FCF CAGR, capped to a sane band.
  - `derive_discount_rate(beta, rf, erp)` — CAPM; `rf`/`erp` configurable with
    sensible defaults (env-overridable).
  - terminal growth default 2.5%.
- **`engine.py`** — the math (all `Decimal`):
  - `dcf(fcf_base, growth_rates, discount_rate, terminal_growth, net_debt, shares)`
    → multi-stage FCF projection → enterprise value → equity value →
    fair value per share.
  - `reverse_dcf(price, fcf_base, discount_rate, terminal_growth, net_debt, shares)`
    → implied growth the current price bakes in (ai-berkshire's reality check).
  - `three_scenario(input, assumptions)` → optimistic / neutral / pessimistic
    target prices + probability-weighted blend.
  - `margin_of_safety(fair_value, price)` → percent.
  - `current_multiples(metrics)` and `historical_multiples(history, daily_bars)`
    → the company's own PE/PS band over 5yr (from price × historical EPS/rev).
- **`verify.py`** — ai-berkshire rigor:
  - `cross_source_check(values_by_source, tolerance=Decimal("0.01"))` → >1%
    discrepancy flag.
  - `verify_market_cap(price, shares, reported)` → sanity check.

**Invalid-input handling (ai-berkshire "sparse data → first principles, don't
fabricate"):** when FCF is negative or history is missing, `dcf()` is not run;
the engine returns a multiples-only `ValuationResult` with `fair_value=None`, a
downgraded `data_quality`, and an explanatory `warnings[]` entry. It never emits
a fabricated fair value.

### Component 2 — Data access

- New web internal route **`GET /api/internal/yahoo/valuation-inputs?symbol=`**
  returning `{ metrics, history (5yr), dailyBars }` in one shot, reusing
  `getFundamentalsBundle` / `getHistorical` / `getDailyBars`. Bearer-auth like
  the other `/api/internal/*` routes.
- A small Python fetcher in the valuation package (or in the api router) calls
  this route and maps it to `ValuationInput`.

### Component 3 — Chat surface

- New chat tool **`value_stock`** in `apps/web/server/llm/tools.ts` → web proxy
  **`/api/research/valuation?symbol=`** → new api router **`GET /valuation`**
  (`apps/api/app/routers/valuation.py`) → core → `ValuationResult` JSON.
- New **`ValuationCard.vue`**: fair-value-vs-price gauge, 3-scenario bars,
  margin-of-safety figure, assumptions table, data-quality + veto badges.
- Tool registered in the system prompt tool catalog (`chat-context.ts`).

### Component 4 — Pipeline integration (LangGraph)

- In `apps/api/app/services/agents/graph.py` `run_graph`, after company
  resolution and before/around graph execution, compute the `ValuationResult`
  **once per run** (in-process call to the core; same app).
- Inject a compact valuation summary into the **Research Manager** and **Risk
  Manager** context as a required input. Mechanism: a new state field threaded
  into the prompt context (preferred) or appended to the existing
  memory-injection channel — chosen during planning based on what the upstream
  `tradingagents` state allows without forking prompts in site-packages.
- Also expose `get_valuation(ticker)` as a toolkit tool so the LLM can re-run
  with its own assumptions; baseline injection means the result is present even
  if the LLM never calls it.
- **Soft veto, post-hoc** in `_parse_rating` / `run_graph`: if
  `veto.triggered` and the parsed rating exceeds `veto.rating_cap`, apply the
  cap, but preserve the agent's original rating + reasoning + the veto reason in
  the structured verdict, and emit a new **`valuation-veto`** stream event
  (`streaming.py`) rendered in `AgentTimeline.vue`.

## Data flow

**Chat:** `value_stock` tool → `/api/research/valuation` (web proxy) →
api `GET /valuation` → core fetches `/api/internal/yahoo/valuation-inputs` →
computes `ValuationResult` → rendered by `ValuationCard.vue`.

**Pipeline:** `run_graph` → core (same internal-inputs fetch) → inject summary
into judge context → graph runs → verdict parsed → soft veto applied / surfaced →
`valuation-veto` event + structured verdict.

## Error handling

- Data fetch failure → `ValuationResult` with `data_quality="unavailable"`,
  `warnings`, no fabricated numbers; chat card shows a friendly empty state; the
  pipeline proceeds valuation-blind (logged) rather than crashing.
- Negative/zero FCF, zero shares, missing history → multiples-only result (see
  invalid-input handling above).
- All `Decimal` conversions guard against `None`/`NaN`; bad inputs degrade to
  `warnings`, never exceptions that abort a run.

## Testing (TDD)

- **pytest** golden-value tests against hand-computed `Decimal` fixtures: `dcf`,
  `reverse_dcf`, `margin_of_safety`, `three_scenario`, `current_multiples`,
  `historical_multiples`, `cross_source_check`, `verify_market_cap`.
- Veto: cap applied when triggered + rating exceeds cap; original rating and
  reason both surfaced; no change when not triggered or rating already ≤ cap.
- Assumptions: CAGR dampening/capping, CAPM derivation.
- Edge cases: negative FCF, missing history, zero shares, `None` metrics →
  multiples-only / unavailable, never an exception.
- **vitest**: `/api/internal/yahoo/valuation-inputs` route shape, `/api/research/
  valuation` proxy, `value_stock` tool. Plus `npx nuxi typecheck`.
- Run locally per project convention: api `cd apps/api && uv run pytest`;
  web `cd apps/web && npx vitest run` / `npx nuxi typecheck`. Rebuild containers
  after changes (`docker compose up -d --build {api|web}`).

## Scope

**In (v1):** deterministic core (DCF, reverse-DCF, 3-scenario, margin of safety,
current + historical-self multiples), CAPM + FCF-CAGR auto-derived assumptions
with LLM override, cross-source >1% check + market-cap verify, structured
`ValuationResult`, both surfaces (chat card + pipeline injection), soft veto.

**Deferred (v2):**
- Peer-relative multiples (requires peer-discovery).
- Benford's-law leading-digit fraud screen.
- A full standalone A/B/C information-richness subsystem (v1 ships only a
  lightweight `data_quality` completeness flag).
- Feeding valuation error (fair-value vs realized price) into the reflection
  learning loop as a per-role lesson signal.

## Out of scope

Bottleneck-hunter / universe screening, value-investor persona layer, and
verdict-contract JSON-ification beyond the valuation fields — each is its own
spec → plan → build cycle.
