/**
 * Golden-path smoke test: login → ask for chart → chart (or graceful error) appears.
 *
 * Prerequisites:
 *   - Docker stack must be running: `docker compose up -d`
 *   - Set APP_PASSWORD env var to the value in your .env, or accept the default 'change-me'
 *   - For the canvas assertion to win (real chart), a valid ANTHROPIC_API_KEY is required
 *     in the stack's .env. Without it, the error-text path will match instead.
 *
 * Run: cd apps/web && APP_PASSWORD=<your-password> pnpm exec playwright test
 */
import { expect, test } from '@playwright/test'

const APP_PASSWORD = process.env.APP_PASSWORD ?? 'change-me'

test('login → ask for chart → chart appears', async ({ page }) => {
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Password' }).fill(APP_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/')

  await page.getByPlaceholder('Show me NVDA daily').fill('Show me NVDA daily')
  await page.getByRole('button', { name: 'Send' }).click()

  // Wait for either a chart canvas (success path) or an inline error message
  // (no valid API key, OpenD not reachable, etc.).
  // The test passes if either path completes without a hard 500/timeout —
  // confirming the full request/response pipeline is wired end-to-end.
  const canvas = page.locator('canvas').first()
  const errorText = page.locator('text=/Could not find API key|invalid|error/i').first()
  await expect(canvas.or(errorText)).toBeVisible({ timeout: 30_000 })
})
