import { test, expect } from '@playwright/test'

test('happy path: AAPL agents run shows timeline + verdict', async ({ page }) => {
  await page.goto('/login')
  await page.fill('[name=password]', process.env.APP_PASSWORD!)
  await page.click('button[type=submit]')
  await page.goto('/research/AAPL')
  await page.click('button:has-text("Run agents")')
  await expect(page.locator('[data-testid=agent-step-card]').first()).toBeVisible({ timeout: 4000 })
  await expect(page.locator('[data-testid=agent-verdict]')).toBeVisible({ timeout: 8000 })
})
