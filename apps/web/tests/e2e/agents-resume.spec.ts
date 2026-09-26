import { test, expect, type Route } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resume e2e. Write-only: CI does not run this spec yet.
 *
 * The page opens `?run=<id>` on a failed run whose persisted events come from
 * the `aapl-fail` fixture. Resume returns JSON, and the next agent-events
 * subscription (after the last seen seq) carries the `aapl-resume` fixture.
 * Every network edge is mocked with `page.route`, so no DB or api is needed.
 */

const FAILED_RUN_ID = 'aapl-resume-1'

function fixtureLines(name: string): string[] {
  return readFileSync(resolve(__dirname, `../fixtures/agents-runs/${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(l => l.trim())
}

function sseBody(lines: string[], firstSeq: number, end: { status: string, error: string | null }): string {
  const run = `event: run\ndata: ${JSON.stringify({ startedAt: '2026-05-10T10:00:00Z' })}\n\n`
  const events = lines.map((l, i) => `id: ${firstSeq + i}\ndata: ${l}\n\n`).join('')
  return `${run}${events}event: end\ndata: ${JSON.stringify(end)}\n\n`
}

test.skip(({ browserName }) => browserName !== 'chromium', 'write-only spec; CI runs chromium happy path')

test('resume: a failed run offers Resume, and the resumed events follow its timeline', async ({ page }) => {
  const failed = fixtureLines('aapl-fail')
  const resumed = fixtureLines('aapl-resume')
  const eventUrls: string[] = []
  let didResume = false

  const json = (route: Route, body: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })

  await page.route('**/api/research/agent-runs?*', route => json(route, { rows: [] }))
  await page.route('**/api/research/active-runs', route => json(route, { active: [], recentlyFinished: [] }))
  await page.route('**/api/research/agents-resume', async (route) => {
    didResume = true
    await json(route, { runId: FAILED_RUN_ID, status: 'running' })
  })
  await page.route('**/api/research/agent-events?*', async (route) => {
    eventUrls.push(route.request().url())
    const body = didResume
      ? sseBody(resumed, failed.length, { status: 'complete', error: null })
      : sseBody(failed, 0, { status: 'failed', error: 'upstream LLM timed out' })
    await route.fulfill({ contentType: 'text/event-stream', body })
  })

  await page.goto('/login')
  await page.fill('[name=password]', process.env.APP_PASSWORD!)
  await page.click('button[type=submit]')
  await page.goto(`/research/AAPL?run=${FAILED_RUN_ID}`)

  const resumeBtn = page.locator('[data-testid=agent-resume-button]')
  await expect(resumeBtn).toBeVisible({ timeout: 4000 })
  await expect(page.locator('[data-testid=agent-resume-banner]')).toContainText('upstream LLM timed out')

  await resumeBtn.click()
  await expect(page.locator('[data-testid=agent-verdict]')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('[data-testid=agent-verdict]')).toContainText('buy')
  expect(eventUrls.at(-1)).toContain(`after=${failed.length - 1}`)
})
