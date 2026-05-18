# Contextual News Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every ticker news fetch also return the macro, sector, and peer news that explains *why* a stock moved, via one shared helper reused by the chat tool and the Python research agents.

**Architecture:** A new `apps/web/server/lib/contextual-news.ts` helper fetches three groups in parallel — ticker news (existing behavior), a cached deterministic macro baseline (fixed Fed/rates + broad-market queries), and LLM-derived ticker-specific angles (sector/peers/geopolitics) — then dedupes and caps them. A new bearer-guarded `/internal/news/contextual` route and a new `ticker_news_context` chat tool both call it; the Python `get_news` tool is repointed at the new route.

**Tech Stack:** Nuxt 4 / h3 server routes, Vercel AI SDK (`generateObject` + `buildModel`), Vitest (web), Zod, Python LangChain `@tool` + httpx, pytest.

---

## File Structure

- **Create** `apps/web/server/lib/contextual-news.ts` — `getContextualNews()` helper: orchestration, macro cache, LLM angle derivation, merge/dedupe/cap.
- **Create** `apps/web/server/api/internal/news/contextual.get.ts` — bearer-guarded route wrapping the helper (mirrors `symbol.get.ts`).
- **Modify** `apps/web/server/llm/tools.ts` — add `ticker_news_context` tool (leave `search_news` untouched).
- **Modify** `apps/api/app/services/agents/toolkit.py` — repoint `get_news` at `/api/internal/news/contextual`, render grouped output.
- **Create** `apps/web/tests/unit/contextual-news.test.ts` — unit tests for the helper.
- **Create** `apps/web/tests/unit/internal-news-contextual.test.ts` — route guard/shape tests.
- **Modify** `apps/api/tests/agents/test_toolkit.py` — update `get_news` tests for the new route + grouped output.

Shared types/helpers reused: `NewsResult` from `apps/web/server/lib/search.ts`, `buildModel` from `apps/web/server/llm/model.ts`, `recordUsageSafely` from `apps/web/server/lib/llm-cost.ts`, `requireInternalBearer` from `apps/web/server/api/internal/_guard.ts`.

---

## Task 1: `getContextualNews` helper — ticker + macro merge (no LLM yet)

**Files:**
- Create: `apps/web/server/lib/contextual-news.ts`
- Test: `apps/web/tests/unit/contextual-news.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/contextual-news.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchMock = vi.fn()
vi.mock('../../server/lib/search', () => ({ searchWithFallback: searchMock }))

// Stub the LLM layer so Task 1 only exercises ticker + macro.
const deriveMock = vi.fn()
vi.mock('../../server/lib/contextual-news-angles', () => ({ deriveAngles: deriveMock }))

let getContextualNews: typeof import('../../server/lib/contextual-news')['getContextualNews']

beforeEach(async () => {
  vi.resetModules()
  searchMock.mockReset()
  deriveMock.mockReset()
  deriveMock.mockResolvedValue([]) // no contextual queries in this task
  ;({ getContextualNews } = await import('../../server/lib/contextual-news'))
})

function news(title: string, url: string) {
  return { title, url, content: title }
}

describe('getContextualNews — ticker + macro', () => {
  it('returns ticker and macro groups from separate searches', async () => {
    searchMock.mockImplementation(async (_kind: string, q: string) => {
      if (q.includes('NVDA')) return [news('nvidia earnings', 'https://a/1')]
      return [news('fed holds rates', 'https://b/1')]
    })

    const res = await getContextualNews({ symbol: 'NVDA', companyName: 'NVIDIA Corp', maxResults: 5 })

    expect(res.ticker.map(r => r.url)).toEqual(['https://a/1'])
    expect(res.macro.length).toBeGreaterThan(0)
    expect(res.contextual).toEqual([])
  })

  it('dedupes across groups, ticker wins', async () => {
    searchMock.mockResolvedValue([news('shared', 'https://dup/1')])
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    const allUrls = [...res.ticker, ...res.macro, ...res.contextual].map(r => r.url)
    expect(allUrls.filter(u => u === 'https://dup/1')).toHaveLength(1)
    expect(res.ticker.map(r => r.url)).toContain('https://dup/1')
  })

  it('caps macro at 4', async () => {
    searchMock.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => news(`m${i}`, `https://m/${i}`)),
    )
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    expect(res.macro.length).toBeLessThanOrEqual(4)
  })

  it('survives a failing search group', async () => {
    searchMock.mockImplementation(async (_k: string, q: string) => {
      if (q.includes('NVDA')) return [news('ok', 'https://a/1')]
      throw new Error('macro provider down')
    })
    const res = await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    expect(res.ticker).toHaveLength(1)
    expect(res.macro).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts`
Expected: FAIL — `Cannot find module '../../server/lib/contextual-news'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/server/lib/contextual-news.ts`:

```ts
import type { NewsResult } from './search'
import { searchWithFallback } from './search'
import { deriveAngles } from './contextual-news-angles'

export interface ContextualNews {
  ticker: NewsResult[]
  macro: NewsResult[]
  contextual: NewsResult[]
}

export interface GetContextualNewsArgs {
  symbol: string
  companyName?: string
  maxResults?: number
}

// Fixed, ticker-agnostic queries → covers rates/monetary policy + broad market.
const MACRO_QUERIES = [
  'Federal Reserve interest rate decision FOMC inflation',
  'US stock market today S&P 500 Nasdaq selloff rally bond yields',
]

const MACRO_CAP = 4
const CONTEXTUAL_CAP = 6

async function safeSearch(query: string, max: number): Promise<NewsResult[]> {
  try {
    return await searchWithFallback('news', query, max)
  } catch {
    return []
  }
}

export async function getContextualNews(
  args: GetContextualNewsArgs,
): Promise<ContextualNews> {
  const maxResults = args.maxResults ?? 10
  const tickerQuery = args.companyName
    ? `${args.companyName} ${args.symbol}`
    : args.symbol

  const [tickerRaw, macroRaw, angleQueries] = await Promise.all([
    safeSearch(tickerQuery, maxResults),
    fetchMacro(),
    deriveAngles({ symbol: args.symbol, companyName: args.companyName }),
  ])

  const contextualRaw = (
    await Promise.all(angleQueries.map(q => safeSearch(q, 4)))
  ).flat()

  const seen = new Set<string>()
  const take = (items: NewsResult[], cap: number): NewsResult[] => {
    const out: NewsResult[] = []
    for (const it of items) {
      if (!it?.url || seen.has(it.url)) continue
      seen.add(it.url)
      out.push(it)
      if (out.length >= cap) break
    }
    return out
  }

  // Ticker wins URL ties, then macro, then contextual.
  return {
    ticker: take(tickerRaw, maxResults),
    macro: take(macroRaw, MACRO_CAP),
    contextual: take(contextualRaw, CONTEXTUAL_CAP),
  }
}

async function fetchMacro(): Promise<NewsResult[]> {
  const groups = await Promise.all(MACRO_QUERIES.map(q => safeSearch(q, MACRO_CAP)))
  return groups.flat()
}
```

Also create the stub `apps/web/server/lib/contextual-news-angles.ts` (real impl in Task 2):

```ts
export interface DeriveAnglesArgs {
  symbol: string
  companyName?: string
}

// Replaced with an LLM-backed implementation in Task 2.
export async function deriveAngles(_args: DeriveAnglesArgs): Promise<string[]> {
  return []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/server/lib/contextual-news.ts apps/web/server/lib/contextual-news-angles.ts apps/web/tests/unit/contextual-news.test.ts
git commit -m "feat(news): contextual news helper — ticker + macro groups"
```

---

## Task 2: Macro query caching

**Files:**
- Modify: `apps/web/server/lib/contextual-news.ts`
- Test: `apps/web/tests/unit/contextual-news.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe('getContextualNews — ticker + macro', ...)` block in `apps/web/tests/unit/contextual-news.test.ts`:

```ts
  it('serves macro from cache within TTL (no repeat provider calls)', async () => {
    searchMock.mockImplementation(async (_k: string, q: string) => {
      if (q.includes('NVDA') || q.includes('TSLA')) return [news('t', 'https://t/1')]
      return [news('macro', `https://m/${Math.random()}`)]
    })

    await getContextualNews({ symbol: 'NVDA', maxResults: 5 })
    const callsAfterFirst = searchMock.mock.calls.filter(c => c[1].includes('Federal Reserve')).length

    await getContextualNews({ symbol: 'TSLA', maxResults: 5 })
    const callsAfterSecond = searchMock.mock.calls.filter(c => c[1].includes('Federal Reserve')).length

    expect(callsAfterFirst).toBe(1)
    expect(callsAfterSecond).toBe(1) // second call reused the cache
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts -t "serves macro from cache"`
Expected: FAIL — `expected 2 to be 1` (macro re-fetched on the second call).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/server/lib/contextual-news.ts`, replace the `fetchMacro` function with a cached version and add the cache state above it:

```ts
const MACRO_TTL_MS = 10 * 60 * 1000
let macroCache: { at: number; data: NewsResult[] } | null = null

async function fetchMacro(): Promise<NewsResult[]> {
  if (macroCache && Date.now() - macroCache.at < MACRO_TTL_MS) {
    return macroCache.data
  }
  const groups = await Promise.all(MACRO_QUERIES.map(q => safeSearch(q, MACRO_CAP)))
  const data = groups.flat()
  macroCache = { at: Date.now(), data }
  return data
}
```

(`vi.resetModules()` in `beforeEach` re-imports the module, so the cache does not leak between tests; within a single test two calls share it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/server/lib/contextual-news.ts apps/web/tests/unit/contextual-news.test.ts
git commit -m "feat(news): cache deterministic macro queries (10m TTL)"
```

---

## Task 3: LLM angle derivation

**Files:**
- Modify: `apps/web/server/lib/contextual-news-angles.ts`
- Test: `apps/web/tests/unit/contextual-news-angles.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/contextual-news-angles.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: generateObjectMock }))
vi.mock('../../server/llm/model', () => ({ buildModel: () => ({}) }))
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely: vi.fn() }))

let deriveAngles: typeof import('../../server/lib/contextual-news-angles')['deriveAngles']

beforeEach(async () => {
  vi.resetModules()
  generateObjectMock.mockReset()
  process.env.LLM_MODEL = 'anthropic/claude-sonnet-4-6'
  ;({ deriveAngles } = await import('../../server/lib/contextual-news-angles'))
})

describe('deriveAngles', () => {
  it('returns the model-derived queries, clamped to 4', async () => {
    generateObjectMock.mockResolvedValue({
      object: { queries: ['semis export controls', 'AMD AI demand', 'q3', 'q4', 'q5'] },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const out = await deriveAngles({ symbol: 'NVDA', companyName: 'NVIDIA Corp' })
    expect(out).toEqual(['semis export controls', 'AMD AI demand', 'q3', 'q4'])
  })

  it('drops empty/whitespace queries', async () => {
    generateObjectMock.mockResolvedValue({
      object: { queries: ['  ', 'real query', ''] },
      usage: undefined,
    })
    const out = await deriveAngles({ symbol: 'NVDA' })
    expect(out).toEqual(['real query'])
  })

  it('returns [] when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('llm down'))
    const out = await deriveAngles({ symbol: 'NVDA' })
    expect(out).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news-angles.test.ts`
Expected: FAIL — current stub always returns `[]`, so the first two tests fail (`expected [] to equal [...]`).

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `apps/web/server/lib/contextual-news-angles.ts`:

```ts
import { generateObject } from 'ai'
import { z } from 'zod'
import { buildModel } from '../llm/model'
import { recordUsageSafely } from './llm-cost'

export interface DeriveAnglesArgs {
  symbol: string
  companyName?: string
  sector?: string
}

const AnglesSchema = z.object({
  queries: z.array(z.string()).max(8),
})

const SYSTEM_PROMPT = [
  'You generate short web-search queries that surface the MACRO, SECTOR,',
  'and PEER/GEOPOLITICAL news that could explain why a given stock moved.',
  'Do NOT include the company itself — ticker-specific news is fetched',
  'separately. Focus on: the sector and close competitors, supply-chain',
  'or regulatory exposure, and commodities/geopolitics relevant to this',
  'company. Return 2-4 concise queries (3-7 words each).',
].join(' ')

export async function deriveAngles(args: DeriveAnglesArgs): Promise<string[]> {
  const who = [args.companyName, `(${args.symbol})`, args.sector ? `sector: ${args.sector}` : '']
    .filter(Boolean)
    .join(' ')
  try {
    const { object, usage } = await generateObject({
      model: buildModel(),
      schema: AnglesSchema,
      system: SYSTEM_PROMPT,
      prompt: `Company: ${who}\nReturn macro/sector/peer search queries.`,
    })
    if (usage) {
      await recordUsageSafely({
        source: 'contextual-news-angles',
        modelSpec: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4-6',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      })
    }
    return object.queries
      .map(q => q.trim())
      .filter(q => q.length > 0)
      .slice(0, 4)
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news-angles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full helper suite to confirm no regression**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts tests/unit/contextual-news-angles.test.ts`
Expected: PASS (8 tests total — Task 1/2 still green with the real `deriveAngles` mocked at the `ai` boundary in their own file).

- [ ] **Step 6: Commit**

```bash
git add apps/web/server/lib/contextual-news-angles.ts apps/web/tests/unit/contextual-news-angles.test.ts
git commit -m "feat(news): LLM-derived macro/sector/peer angle queries"
```

---

## Task 4: `/internal/news/contextual` route

**Files:**
- Create: `apps/web/server/api/internal/news/contextual.get.ts`
- Test: `apps/web/tests/unit/internal-news-contextual.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/tests/unit/internal-news-contextual.test.ts`:

```ts
import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getContextualNewsMock = vi.fn()
vi.mock('../../server/lib/contextual-news', () => ({
  getContextualNews: getContextualNewsMock,
}))

type Handler = (event: H3Event) => unknown
let handler: Handler

beforeEach(async () => {
  vi.resetModules()
  getContextualNewsMock.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/news/contextual.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  return { node: { req: { headers } }, context: {}, path: search ? `/?${search}` : '/' } as unknown as H3Event
}

describe('/internal/news/contextual', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('400 when symbol missing', async () => {
    await expect(
      handler(makeEvent({ authorization: 'Bearer test-bearer' }, {})),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns grouped results', async () => {
    getContextualNewsMock.mockResolvedValue({
      ticker: [{ title: 't', url: 'u1', content: 'c' }],
      macro: [{ title: 'm', url: 'u2', content: 'c' }],
      contextual: [],
    })
    const res = (await handler(
      makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA', company: 'NVIDIA Corp' }),
    )) as { symbol: string; ticker: unknown[]; macro: unknown[]; contextual: unknown[] }
    expect(res.symbol).toBe('NVDA')
    expect(res.ticker).toHaveLength(1)
    expect(res.macro).toHaveLength(1)
    expect(getContextualNewsMock).toHaveBeenCalledWith({
      symbol: 'NVDA',
      companyName: 'NVIDIA Corp',
      maxResults: 10,
    })
  })

  it('returns empty groups + error on failure', async () => {
    getContextualNewsMock.mockRejectedValue(new Error('boom'))
    const res = (await handler(
      makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' }),
    )) as { ticker: unknown[]; macro: unknown[]; contextual: unknown[]; error?: string }
    expect(res.ticker).toEqual([])
    expect(res.macro).toEqual([])
    expect(res.contextual).toEqual([])
    expect(res.error).toBe('boom')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run tests/unit/internal-news-contextual.test.ts`
Expected: FAIL — `Cannot find module '../../server/api/internal/news/contextual.get'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/server/api/internal/news/contextual.get.ts`:

```ts
import { createError, defineEventHandler, getQuery } from 'h3'
import { getContextualNews } from '../../../lib/contextual-news'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, company, max_results } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const maxResults = Math.min(parseInt((max_results as string) ?? '10', 10) || 10, 25)
  try {
    const groups = await getContextualNews({
      symbol,
      companyName: typeof company === 'string' && company ? company : undefined,
      maxResults,
    })
    return { symbol, ...groups }
  } catch (e: unknown) {
    return {
      symbol,
      ticker: [],
      macro: [],
      contextual: [],
      error: (e as Error)?.message ?? 'search failed',
    }
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && npx vitest run tests/unit/internal-news-contextual.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/server/api/internal/news/contextual.get.ts apps/web/tests/unit/internal-news-contextual.test.ts
git commit -m "feat(news): /internal/news/contextual route"
```

---

## Task 5: `ticker_news_context` chat tool

**Files:**
- Modify: `apps/web/server/llm/tools.ts` (insert after the `search_news` tool, around line 159)
- Test: none (thin wrapper; covered by the helper's unit tests and existing chat-tool integration). Verified by typecheck + build.

- [ ] **Step 1: Add the tool**

In `apps/web/server/llm/tools.ts`, add the import near the top (next to the existing `searchWithFallback` import on line 5):

```ts
import { getContextualNews } from '../lib/contextual-news'
```

Then insert this tool immediately after the closing `}),` of the `search_news` tool (after line 159):

```ts
    'ticker_news_context': tool({
      description:
        'News for a STOCK plus the macro, sector, and peer/geopolitical news '
        + 'that explains WHY it moved (Fed/rates, market-wide selloffs, '
        + 'competitors, supply-chain, commodities). Prefer this over '
        + 'search_news for any stock question — especially "why did X drop/'
        + 'rise". Returns three groups: ticker, macro, contextual.',
      inputSchema: z.object({
        symbol: z.string(),
        companyName: z.string().optional(),
        maxResults: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ symbol, companyName, maxResults }) =>
        getContextualNews({ symbol, companyName, maxResults }),
    }),
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && npx nuxi typecheck`
Expected: PASS — no type errors (the `tool`/`z` imports already exist in this file; confirm `getContextualNews`'s return type satisfies the tool result).

- [ ] **Step 3: Commit**

```bash
git add apps/web/server/llm/tools.ts
git commit -m "feat(chat): ticker_news_context tool with macro/sector context"
```

---

## Task 6: Repoint Python `get_news` at the contextual route

**Files:**
- Modify: `apps/api/app/services/agents/toolkit.py` (the `get_news` tool, lines ~230-242)
- Test: `apps/api/tests/agents/test_toolkit.py` (update the three `get_news` tests)

- [ ] **Step 1: Update the failing tests**

In `apps/api/tests/agents/test_toolkit.py`:

Replace the JSON body returned by `fake_get` in `test_get_news_*` (the company-name test, lines ~150-170) so it matches the new route shape, and update assertions:

```python
# in the company-name test's fake_get.json():
def json(self):
    return {
        "symbol": "US.MU",
        "ticker": [{"title": "micron earnings", "url": "u1", "content": "c"}],
        "macro": [{"title": "fed holds", "url": "u2", "content": "c"}],
        "contextual": [{"title": "DRAM prices", "url": "u3", "content": "c"}],
    }

# assertions for that test:
assert captured["url"].endswith("/api/internal/news/contextual")
assert "Micron Technology, Inc." in captured["params"]["company"]
assert captured["params"]["symbol"] == "US.MU"
assert "Micron Technology, Inc." in result
assert "Macro" in result and "fed holds" in result
```

In `test_get_news_without_company_name_is_unchanged`, change `fake_get.json()` to:

```python
def json(self):
    return {
        "symbol": "NVDA",
        "ticker": [{"title": "x", "url": "u1", "content": "c"}],
        "macro": [],
        "contextual": [],
    }
```

and replace its assertions with:

```python
assert captured["url"].endswith("/api/internal/news/contextual")
assert captured["params"]["symbol"] == "NVDA"
assert "company" not in captured["params"] or not captured["params"]["company"]
assert "News for NVDA" in result
```

In `test_get_news_handles_search_failure`, change `fake_get.json()` to:

```python
def json(self):
    return {"symbol": "NVDA", "ticker": [], "macro": [], "contextual": [], "error": "no key"}
```

(The existing final assertion `assert "News search not configured" in result or "no key" in result.lower()` stays.)

Add capture of the URL in each test's `fake_get` (if not already captured):

```python
async def fake_get(self, url, headers=None, params=None, timeout=None, **kwargs):
    captured["params"] = params
    captured["url"] = url
    ...
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/api && python -m pytest tests/agents/test_toolkit.py -k get_news -v`
Expected: FAIL — `get_news` still calls `/api/internal/news/symbol` and emits the old `News for ... [results]` shape, so the new URL/`Macro` assertions fail.

- [ ] **Step 3: Update `get_news`**

In `apps/api/app/services/agents/toolkit.py`, replace the `get_news` tool body (lines ~230-242) with:

```python
    @tool
    async def get_news(ticker: str, start_date: str, end_date: str) -> str:
        """Retrieve news for a ticker PLUS the macro, sector, and peer news
        that explains why it moved (rates/Fed, market-wide moves,
        competitors, geopolitics)."""
        del start_date, end_date  # search returns recent news regardless
        params: dict[str, Any] = {"symbol": ticker, "max_results": 10}
        if company_name:
            params["company"] = company_name
        data = await _internal_get("/api/internal/news/contextual", params)
        if data.get("error") and not (
            data.get("ticker") or data.get("macro") or data.get("contextual")
        ):
            return "News search not configured. Skipping news analysis."

        def _section(title: str, items: list) -> str:
            if not items:
                return ""
            return f"### {title}\n```json\n{json.dumps(items, indent=2)}\n```\n"

        body = (
            _section("Ticker", data.get("ticker", []))
            + _section("Macro", data.get("macro", []))
            + _section("Sector & Peers", data.get("contextual", []))
        ) or "No news found."
        return f"News for {_label(ticker)}:\n{body}"
```

(`json` and `Any` are already imported at the top of `toolkit.py`; `company_name` and `_label` are already in scope inside `build_toolkit`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && python -m pytest tests/agents/test_toolkit.py -k get_news -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/services/agents/toolkit.py apps/api/tests/agents/test_toolkit.py
git commit -m "feat(agents): get_news returns grouped macro/sector context"
```

---

## Task 7: Full verification & rebuild

**Files:** none (verification only)

- [ ] **Step 1: Web test suite**

Run: `cd apps/web && npx vitest run tests/unit/contextual-news.test.ts tests/unit/contextual-news-angles.test.ts tests/unit/internal-news-contextual.test.ts`
Expected: PASS (all green).

- [ ] **Step 2: Web typecheck**

Run: `cd apps/web && npx nuxi typecheck`
Expected: PASS — no `any`, no type errors.

- [ ] **Step 3: Python suite**

Run: `cd apps/api && python -m pytest tests/agents/test_toolkit.py -v`
Expected: PASS — all toolkit tests including the unrelated ones.

- [ ] **Step 4: Rebuild containers (neither api nor web bind-mounts source)**

Run: `docker compose up -d --build web api`
Expected: both containers rebuild and start healthy.

- [ ] **Step 5: Manual smoke (optional but recommended)**

In the chat UI, ask "why did NVDA drop today?" and confirm the model calls `ticker_news_context` and cites macro/sector items, not just ticker headlines. Run a research agent and confirm the News Analyst output shows `### Macro` / `### Sector & Peers` sections.

- [ ] **Step 6: Commit any rebuild-related lockfile/config drift (if any)**

```bash
git status --porcelain   # if clean, nothing to commit
```

---

## Notes for the implementer

- **`sector` is intentionally unused by callers.** `deriveAngles` accepts an optional `sector` for future use, but neither the route nor the chat tool resolve/pass it (YAGNI). The LLM infers sector from the company name. Do not add a sector lookup.
- **Do not touch `search_news`, `/internal/news/symbol`, `/internal/news/global`, or `get_global_news`.** They remain for non-ticker and existing-node use; this work is purely additive plus the one `get_news` repoint.
- **Cache is module-scoped and process-local.** That is acceptable — it is best-effort and the web server is a single Nuxt process per container. No external cache.
- **TDD ordering matters:** in Task 1 the `deriveAngles` is mocked at the module boundary; in Task 3 it is mocked at the `ai` SDK boundary in its own test file. Keep these mock boundaries as written so suites stay isolated.
