# Portfolio Answer Harness — Design

Date: 2026-07-25
Status: approved for implementation

## Problem

Asked to "check my portfolio", the chat answered:

> Your portfolio barely flinched — net worth went from RM 140,712 → RM 140,654, a drop of just
> –0.04% overnight. […] You're essentially flat while the Nasdaq shed 2.2%.

Both data sources involved are correct and both are wanted. Ghostfolio is the user's whole-net-worth
tracker (it also mirrors the Moomoo account). Moomoo is the platform the user actually invests on.
The failure is that the chat answered an **investing** question with a **net-worth** number and never
said which layer it was reporting. Net worth includes cash and non-investment accounts, so a real
equity move is diluted into noise.

Three distinct defects sit behind that one bad answer.

### D1 — Scope: portfolio questions resolve to the net-worth layer

`portfolio_performance` reads the `portfolio_snapshots` table. Those rows are written by
`capturePortfolioSnapshot` (`apps/web/server/lib/portfolio-history.ts:141`), whose `netWorth` comes
from Ghostfolio's `totalValueInBaseCurrency` (`apps/web/server/lib/holdings.ts:554`) — total net worth
in MYR, cash and non-investment accounts included.

The fallback resolver `resolvePortfolio` (`apps/web/server/lib/portfolio-snapshot.ts:14`) tries moomoo
**SIMULATE** (paper money) first, then Ghostfolio. There is no live-Moomoo path.

No tool anywhere answers "how are my actual investments doing". `trade_portfolio` returns a
point-in-time snapshot with no baseline.

### D2 — Currency: Moomoo totals are forced to HKD

`opend.py:377` calls `ctx.accinfo_query(acc_id=..., trd_env=env, refresh_cache=True)`. The SDK
signature is:

```
accinfo_query(self, trd_env='REAL', acc_id=0, acc_index=0, refresh_cache=False,
              currency='HKD', asset_category='N/A')
```

We never pass `currency`, so OpenD converts every account scalar (`cash`, `market_val`,
`total_assets`) into HKD and stamps `currency='HKD'`.

There is no per-account base currency to detect: `get_acc_list` exposes no currency field
(`trade_query.py:50-61`). The reporting currency is a **setting the caller supplies**, not a broker
fact. `Currency.MYR` is supported by the SDK (enum members: AUD, CAD, CNH, HKD, JPY, MYR, SGD, USD).

The system prompt then hardcodes the wrong conclusion — "moomoo margin accounts have a BASE/reporting
currency (usually HKD)" (`chat-context.ts:35`) and "moomoo margin accounts report in HKD"
(`tools.ts:248`) — so the model confidently narrates a currency the user does not hold.

### D3 — Baseline: no day-change figure exists

Positions are mapped with cost-basis P&L only — `pl_val` from `unrealized_pl` and `pl_ratio` from
`pl_ratio_avg_cost` (`opend.py:415-416`). Nothing in the stack knows today's move, so an
overnight/market-recap question has nothing correct to draw on.

`prevClosePrice` is already available per symbol on the quote snapshot (`http.ts:31`,
`quote.py:49`), so this is computable without new broker plumbing.

## Decisions

Settled with the user during brainstorming:

1. Default scope for an unqualified "my portfolio" is the **Moomoo live account**.
2. The answer leads with **day change (vs previous close)** and also carries **since-cost P&L**.
3. Reporting currency is **MYR** (the user's actual Moomoo reporting currency), configurable.
4. The harness includes a **golden-question eval suite**, not just unit tests.

## Architecture

### The layer contract

Two named layers. They are never blended, and every portfolio answer states which one it used.

| Layer | Source | Answers |
| --- | --- | --- |
| **Investments** | Moomoo live (`trd_env=REAL`, `acc_role !== 'IPO'`) | "my portfolio", "my positions", "how am I doing", "what moved" — **the default** |
| **Net worth** | Ghostfolio | "my net worth", "total assets", reconciliation — only on request, or as a labelled footnote |

Ghostfolio mirrors the Moomoo account, so the two layers overlap by design. That is exactly why they
must never be added together, and why a net-worth delta must never be presented as investment
performance.

### Component 1 — reporting currency (Python API)

Add a `MOOMOO_REPORT_CURRENCY` setting, default `MYR`, validated against the SDK `Currency` enum
(reject unknown values at startup rather than silently falling back).

`get_portfolio` passes it: `ctx.accinfo_query(..., currency=<configured>)`. The returned scalars
(`cash`, `market_val`, `total_assets`) are then denominated in that currency, and the `currency`
field echoes it.

Per-position `currency` and the `*_cash` native buckets (`us_cash` → USD, `my_cash` → MYR, …) are
already correct and stay untouched — they remain the source of truth for what the user *actually*
holds.

The `Portfolio` schema gains `reporting_currency_source: 'requested'` so no downstream consumer can
mistake the converted total for a native balance.

### Component 2 — `apps/web/server/lib/investment-portfolio.ts`

One module, one public function `getInvestmentPortfolio()`. This becomes the only thing that answers
investment-portfolio questions.

```ts
export interface InvestmentPosition {
  symbol: string
  qty: number
  currency: string | null        // native settlement currency (USD / HKD / …)
  last_price: number
  prev_close: number | null
  market_value: number           // native currency
  day_change_value: number | null
  day_change_pct: number | null
  cost_price: number
  cost_basis: number
  unrealized_pl: number
  unrealized_pl_pct: number
  weight_pct: number | null      // share of FX-normalised total; null when FX unavailable
}

export interface CurrencyTotals {
  currency: string
  market_value: number
  day_change_value: number | null
  day_change_pct: number | null
  unrealized_pl: number
}

export interface InvestmentPortfolio {
  source: 'moomoo_live'
  status: 'ok' | 'no_positions' | 'unavailable'
  as_of: string
  accounts: string[]                          // acc_ids actually used
  reporting_currency: string                  // configured, e.g. MYR
  positions: InvestmentPosition[]
  by_currency: CurrencyTotals[]
  total_market_value_reporting: number | null
  total_day_change_reporting: number | null
  total_day_change_pct: number | null         // FX-weighted blend, index-comparable
  total_unrealized_pl_reporting: number | null
  cash_by_currency: Record<string, number>
  caveats: string[]
}
```

Data flow:

1. `client.listAccounts()`, keep `trd_env === 'REAL' && acc_role !== 'IPO'`.
2. `client.getPortfolio({ acc_id, trd_env: 'REAL' })` per surviving account.
3. Merge positions across accounts: same symbol → summed qty, quantity-weighted average cost.
4. Per unique symbol, `client.getSnapshot({ code })` in parallel → `lastPrice`, `prevClosePrice`.
5. Per position: `day_change_value = qty × (lastPrice − prevClosePrice)`;
   `day_change_pct = day_change_value / (qty × prevClosePrice)`.
6. Aggregate into `by_currency` buckets keyed by native settlement currency.
7. FX-convert each bucket to `reporting_currency` via the existing `getFxRate`, producing the blended
   totals and `total_day_change_pct`.

Cross-currency sums happen only in step 7, only through an explicit FX rate. Native amounts are never
added across currencies.

### Component 3 — chat surface

New tool `investment_portfolio` (no required args). Its description makes it the default for "my
portfolio" / "my positions" / "how am I doing" / "what moved today".

`chat-context.ts` gains a PORTFOLIO SCOPE block stating the layer contract: investments come from
`investment_portfolio`; Ghostfolio answers net worth only; a net-worth delta is never reported as
investment performance and must be labelled "net worth (all accounts, incl. cash)".

Corrections to existing text:

- Delete the "usually HKD" / "report in HKD" claims (`chat-context.ts:35`, `tools.ts:248`). Replace
  with: scalar totals are converted into the server's configured reporting currency, reported in the
  `currency` field; per-position and per-cash-bucket values are native.
- Relabel `portfolio_performance` as **net-worth history**, so the model cannot present it as
  investment performance.

`portfolio_performance`, `holdings_context`, and the snapshot pipeline keep their current behaviour —
they are correct for what they measure. Only their labelling changes.

## Error handling

Partial data degrades; it never throws and never silently falls back to the other layer.

| Failure | Behaviour |
| --- | --- |
| Quote snapshot fails for a symbol | `day_change_value` / `day_change_pct` null for that position; caveat naming the symbol; totals computed from the rest and flagged as partial |
| FX rate unresolved | `total_*_reporting` fields null; `by_currency` blocks still returned in full; caveat names the pair |
| One account errors | Remaining accounts still aggregate; caveat names the failed `acc_id` |
| No live non-IPO account | `status: 'unavailable'` with an explicit reason, so the model says so rather than reaching for net worth |
| No positions | `status: 'no_positions'`, cash still reported |

The rule the harness enforces: an unavailable investments layer produces an honest "I can't see your
Moomoo live account right now", never a net-worth number dressed up as portfolio performance.

## Testing

### Tier 1 — module unit tests (`apps/web/tests/unit/investment-portfolio.test.ts`)

Fixture-driven, deterministic, always run:

- Account selection keeps REAL non-IPO and drops SIMULATE and IPO accounts.
- Day-change math per position, including a zero/absent `prevClosePrice` guard.
- Same symbol held in two accounts merges with quantity-weighted average cost.
- USD and HKD positions produce separate `by_currency` buckets and are never added natively.
- Blended `total_day_change_pct` matches a hand-computed FX-weighted figure.
- Each failure row in the table above produces the right `status`, null fields, and caveat.

### Tier 2 — prompt contract tests (`apps/web/tests/unit/portfolio-prompt-contract.test.ts`)

Guards the narration layer without invoking a model:

- The built system prompt contains the layer-contract rules.
- The built system prompt contains no hardcoded "usually HKD" / "report in HKD" claim.
- `investment_portfolio` is registered and its description routes the default portfolio question.
- `portfolio_performance`'s description identifies it as net-worth history.

### Tier 3 — golden-question eval suite (`apps/web/tests/eval/portfolio-answers.eval.test.ts`)

Opt-in via `EVAL_LLM=1`, skipped by default so CI stays fast and deterministic. Runs golden questions
through the real model with tools mocked against fixtures, asserting on the produced answer:

| Question | Assertions |
| --- | --- |
| "check my portfolio" | calls `investment_portfolio`; names the Moomoo/investments layer; no net-worth figure presented as performance |
| "how did my portfolio do overnight?" | reports a day-change %; does not report the net-worth delta |
| "what's my portfolio worth?" | states MYR (or native per-currency); never says HKD |
| "what's my net worth?" | uses the Ghostfolio layer and labels it as net worth |
| Moomoo live unavailable | says the investments layer is unavailable; does not substitute net worth |

The regression that started this work — a net-worth delta narrated as portfolio performance — is
covered by row 1 and row 2.

### Python side (`apps/api/tests/test_opend_trade.py`)

- `accinfo_query` receives the configured `currency`.
- A configured `MYR` surfaces as `Portfolio.currency == 'MYR'`.
- An invalid configured currency is rejected at startup.

## Investments history (added after the initial four steps)

The investments layer gets its own equity curve, in its own `investment_snapshots` table rather than
sharing `portfolio_snapshots` with net worth. A separate table makes the layer split structural
instead of depending on every query remembering a filter — a missed filter would silently mix the
layers, which is the exact failure this harness exists to prevent.

**Cost basis is stored next to market value.** Market value rises when money is deposited or more
shares are bought, so a value change is *not* a return. `computeInvestmentPerformance` therefore
reports `valueChangePct` (flows included), `costBasisChangePct`, a `flowsDetected` flag, and the
flow-neutral `unrealizedPlPctFirst` / `unrealizedPlPctLast`. The `investment_performance` tool
description and the system prompt both require the model to disclose flows rather than narrate a
deposit as a gain — the same class of error as narrating a net-worth delta as performance.

Capture refuses to write when the layer is `unavailable` or FX left the total unknown: storing a null
as 0 would read back as a crash to zero and poison every derived stat.

**Timeouts.** The api client is constructed without one, so when OpenD is down the underlying HTTP
call hangs on OpenD's reconnect loop. Measured: the capture endpoint ran past 240s. Both capture
routes now bound their reads (`withDeadline`) — 30s for investments, 60s for net worth, the looser
budget because Ghostfolio can legitimately be slow. Measured after: 90s and a 503 naming which read
timed out. A missed snapshot is acceptable; a wedged cron is not.

## Out of scope

- Any change to how Ghostfolio computes net worth.
- A general client-side timeout on the api client. Only the two capture routes are bounded; chat
  tools that legitimately run long (research, agents) are untouched.
- Reconciliation UX between the two layers beyond the existing `holdings_context` behaviour.
- The `/portfolio` page. This spec covers the chat answer path only.

## Build order

1. Python reporting currency (D2) — smallest, unblocks correct currency everywhere.
2. `investment-portfolio.ts` + Tier 1 tests (D1, D3).
3. `investment_portfolio` tool + prompt changes + Tier 2 tests.
4. Tier 3 eval suite.
