import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Resume e2e (Task 8.7) — write-only: this spec is intentionally NOT run by
 * CI yet. The first agents-run streams the ``aapl-fail`` fixture (errors
 * mid-run); the page then loads with ``?run=<id>`` and the Resume button
 * appears; clicking it streams the ``aapl-resume`` fixture which carries a
 * decision + run-end. We use Playwright ``page.route`` for full control over
 * the mock pair instead of the Nitro stub plugin so the test can wire two
 * distinct responses without shared state.
 *
 * The agent-runs lookup (``GET /api/research/agent-runs?run_id=...``) is
 * also mocked so the page sees a ``status: 'failed'`` row when it loads with
 * the deep-link query param.
 */

const FAIL_FIXTURE = resolve(__dirname, '../fixtures/agents-runs/aapl-fail.ndjson')
const RESUME_FIXTURE = resolve(__dirname, '../fixtures/agents-runs/aapl-resume.ndjson')
const FAILED_RUN_ID = 'aapl-resume-1'

test.skip(({ browserName }) => browserName !== 'chromium', 'write-only spec; CI runs chromium happy path')

test('resume: failed run shows resume button, click streams replay decision', async ({ page }) => {
  // 1. Mock the deep-link agent-runs lookup so the page believes a failed
  //    run exists for ``?run=<FAILED_RUN_ID>``.
  await page.route(`**/api/research/agent-runs?run_id=${FAILED_RUN_ID}*`, async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [{
          id: FAILED_RUN_ID,
          symbol: 'AAPL',
          tradeDate: '2026-05-10',
          status: 'failed',
          error: 'upstream LLM timed out',
          rating: null,
          confidence: null,
          alpha: null,
          outcome: null,
          costUsd: '0.04',
          tokensIn: 2000,
          tokensOut: 400,
          startedAt: '2026-05-10T10:00:00Z',
          finishedAt: '2026-05-10T10:01:00Z',
        }],
      }),
    })
  })

  // 2. Mock the symbol-history list (returns nothing — irrelevant for this
  //    spec but the page calls it on mount).
  await page.route('**/api/research/agent-runs?symbol=*', async route => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ rows: [] }),
    })
  })

  // 3. Mock the resume endpoint to stream the resume fixture.
  await page.route('**/api/research/agents-resume', async route => {
    const ndjson = readFileSync(RESUME_FIXTURE, 'utf8')
    await route.fulfill({
      contentType: 'application/x-ndjson',
      headers: { 'cache-control': 'no-store' },
      body: ndjson,
    })
  })

  // 4. Login and navigate with the deep-link query param.
  await page.goto('/login')
  await page.fill('[name=password]', process.env.APP_PASSWORD!)
  await page.click('button[type=submit]')
  await page.goto(`/research/AAPL?run=${FAILED_RUN_ID}`)

  // 5. The Resume banner + button should be visible because the targeted
  //    run is in ``status: 'failed'``.
  const resumeBtn = page.locator('[data-testid=agent-resume-button]')
  await expect(resumeBtn).toBeVisible({ timeout: 4000 })
  await expect(page.locator('[data-testid=agent-resume-banner]')).toContainText('upstream LLM timed out')

  // 6. Click resume — the fixture streams a decision + run-end so the
  //    Verdict component should render.
  await resumeBtn.click()
  await expect(page.locator('[data-testid=agent-verdict]')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('[data-testid=agent-verdict]')).toContainText('buy')

  // sanity: the (unused-here) failure fixture path is still expected on disk
  // so a later author can swap to a stub-driven version.
  expect(readFileSync(FAIL_FIXTURE, 'utf8')).toContain('upstream LLM timed out')
})
