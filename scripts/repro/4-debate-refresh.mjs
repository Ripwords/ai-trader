// Reloading the research page mid-run replays the run's events and follows
// it live, with no ?run= in the URL. Run through 4-debate-refresh.sh, which
// puts the api on the sleeping stub.
import { fail, log, loggedInPage, pass } from './browser.mjs'

const { browser, page } = await loggedInPage()
await page.goto('/research/AAPL')
await page.click('button:has-text("Run agents")')
await page.locator('[data-testid=agent-step-card]').first().waitFor({ timeout: 30_000 })
log('run is live; reloading /research/AAPL without ?run=')

await page.goto('/research/AAPL')
try {
  await page.locator('[data-testid=agent-step-card]').first().waitFor({ timeout: 10_000 })
  log('events replayed after the reload')
  await page.locator('[data-testid=agent-verdict]').waitFor({ timeout: 120_000 })
}
catch {
  fail('the reloaded page did not replay and follow the run')
}
pass('the reloaded page replayed the run and followed it to the verdict')
await browser.close()
