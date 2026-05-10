import { defineNitroPlugin } from 'nitropack/runtime'
import { readBody } from 'h3'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * E2E-only override for the agents endpoints. When E2E_STUB_AGENTS=1,
 * intercept requests and stream a hand-authored NDJSON fixture instead of
 * proxying to the upstream Python agents service.
 *
 * Routes intercepted:
 *   - POST /api/research/agents-run     -> fixture ``<sym>-buy.ndjson``
 *   - POST /api/research/agents-resume  -> fixture ``<sym>-resume.ndjson``
 *
 * For the resume e2e (Task 8.7), the run-* fixture intentionally ends with
 * an ``error`` event so the row flips to ``status='failed'`` and the page
 * shows a Resume button. The resume-* fixture replays a ``decision`` +
 * ``run-end`` so the second pass completes successfully — the same shape
 * upstream would produce when astream(None, thread_id=...) replays from a
 * checkpoint.
 *
 * Implementation note: nitroApp.hooks.hook('request') runs before route
 * matching. We finish the response inline (write headers, stream body, end)
 * which short-circuits the normal handler chain.
 *
 * Fallback: if this plugin doesn't intercept cleanly in some Nitro version,
 * `apps/web/server/api/research/agents-run.post.ts` itself can be patched to
 * check `process.env.E2E_STUB_AGENTS === '1'` and delegate to
 * `server/test-only/agents-stub.ts`.
 */
interface StubBody {
  symbol?: string
  run_id?: string
}

export default defineNitroPlugin((nitroApp) => {
  if (process.env.E2E_STUB_AGENTS !== '1') return

  nitroApp.hooks.hook('request', async (event) => {
    const method = event.node.req.method
    const url = event.node.req.url
    if (method !== 'POST') return

    let fixturePath: string | null = null

    if (url === '/api/research/agents-run') {
      const body = await readBody<StubBody>(event).catch(() => ({} as StubBody))
      const sym = (body.symbol ?? 'AAPL').toLowerCase()
      // The ``X-E2E-Fixture`` header lets a test pick an alternate fixture
      // for the same symbol — used by the resume e2e to flip the first run
      // into a failure (``aapl-fail.ndjson``) without changing the symbol.
      const variant = String(event.node.req.headers['x-e2e-fixture'] ?? 'buy')
      fixturePath = resolve(process.cwd(), `tests/fixtures/agents-runs/${sym}-${variant}.ndjson`)
    } else if (url === '/api/research/agents-resume') {
      const body = await readBody<StubBody>(event).catch(() => ({} as StubBody))
      // For resume the fixture is keyed off the run id's first segment so
      // the e2e can target a specific replay. ``aapl`` is the default for
      // tests that don't care.
      const key = (body.run_id ?? 'aapl').split('-')[0]!.toLowerCase()
      fixturePath = resolve(process.cwd(), `tests/fixtures/agents-runs/${key}-resume.ndjson`)
    }

    if (!fixturePath) return

    const text = await readFile(fixturePath, 'utf8')
    const lines = text.split('\n').filter(l => l.trim())

    const res = event.node.res
    res.setHeader('content-type', 'application/x-ndjson')
    res.setHeader('cache-control', 'no-store')
    res.statusCode = 200

    for (const line of lines) {
      res.write(line + '\n')
      await new Promise(r => setTimeout(r, 80))
    }
    res.end()
  })
})
