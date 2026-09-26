import { defineNitroPlugin } from 'nitropack/runtime'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * E2E-only: with E2E_STUB_AGENTS=1, the web server's calls to the Python
 * agents service are answered from NDJSON fixtures, so everything on the web
 * side (run row, drain, agent_messages, SSE) runs for real.
 *
 *   POST {api}/agents/run              -> tests/fixtures/agents-runs/<sym>-buy.ndjson
 *   POST {api}/agents/run/<id>/resume  -> tests/fixtures/agents-runs/aapl-resume.ndjson
 *
 * For a stub of the api itself, run it with AGENTS_STUB_RUN_SECONDS instead.
 */
const LINE_DELAY_MS = 80

function fixtureResponse(path: string): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const text = await readFile(path, 'utf8')
      for (const line of text.split('\n').filter(l => l.trim())) {
        controller.enqueue(enc.encode(line + '\n'))
        await new Promise(r => setTimeout(r, LINE_DELAY_MS))
      }
      controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
}

export default defineNitroPlugin(() => {
  if (process.env.E2E_STUB_AGENTS !== '1') return

  const fixtures = resolve(process.cwd(), 'tests/fixtures/agents-runs')
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    if (init?.method === 'POST' && url.pathname === '/agents/run') {
      const { symbol } = JSON.parse(String(init.body ?? '{}')) as { symbol?: string }
      return fixtureResponse(resolve(fixtures, `${(symbol ?? 'AAPL').toLowerCase()}-buy.ndjson`))
    }
    if (init?.method === 'POST' && /^\/agents\/run\/[^/]+\/resume$/.test(url.pathname)) {
      return fixtureResponse(resolve(fixtures, 'aapl-resume.ndjson'))
    }
    return realFetch(input, init)
  }
})
