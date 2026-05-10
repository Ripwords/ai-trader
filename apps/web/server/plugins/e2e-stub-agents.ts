import { defineNitroPlugin } from 'nitropack/runtime'
import { readBody } from 'h3'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * E2E-only override for /api/research/agents-run. When E2E_STUB_AGENTS=1,
 * intercept the request and stream a hand-authored NDJSON fixture instead of
 * proxying to the upstream Python agents service.
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
export default defineNitroPlugin((nitroApp) => {
  if (process.env.E2E_STUB_AGENTS !== '1') return

  nitroApp.hooks.hook('request', async (event) => {
    if (event.node.req.method !== 'POST') return
    if (event.node.req.url !== '/api/research/agents-run') return

    interface StubBody { symbol?: string }
    const body = await readBody<StubBody>(event).catch(() => ({} as StubBody))
    const sym = (body.symbol ?? 'AAPL').toLowerCase()
    const path = resolve(process.cwd(), `tests/fixtures/agents-runs/${sym}-buy.ndjson`)
    const text = await readFile(path, 'utf8')
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
