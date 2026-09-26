import { test, expect, type Page, type Route } from '@playwright/test'

/**
 * Chat reattach e2e. Write-only: CI does not run this spec yet.
 *
 * The thread and the resume endpoint are mocked with `page.route`, so no model
 * or DB rows are needed; the rest of the page talks to the real server.
 */

const THREAD = 'th-e2e-resume'
const question = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What moved NVDA today?' }] }

function sse(chunks: unknown[]): string {
  return `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
}

function replyChunks(text: string): unknown[] {
  return [
    { type: 'start', messageId: 'a1' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish' },
  ]
}

const fulfillSse = (route: Route, chunks: unknown[]) => route.fulfill({
  status: 200,
  headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-chat-id': THREAD },
  body: sse(chunks),
})

async function login(page: Page) {
  await page.goto('/login')
  await page.fill('[name=password]', process.env.APP_PASSWORD!)
  await page.click('button[type=submit]')
}

async function mockThread(page: Page, messages: unknown[]) {
  await page.route(`**/api/conversations/${THREAD}`, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ metadata: { pinned: false, archived: false, decisions: [] }, messages }),
  }))
}

test.skip(({ browserName }) => browserName !== 'chromium', 'write-only spec')

test('opening a thread mid-reply follows the reply to the end', async ({ page }) => {
  await login(page)
  await mockThread(page, [question])
  await page.route(`**/api/chat/${THREAD}/stream`, route => fulfillSse(route, replyChunks('Earnings beat, guidance raised.')))

  await page.goto(`/?c=${THREAD}`)
  await expect(page.getByText('Earnings beat, guidance raised.')).toBeVisible()
  await expect(page.locator('[data-testid=chat-interruption]')).toHaveCount(0)
})

test('a question with no reply offers Retry, which answers it', async ({ page }) => {
  await login(page)
  await mockThread(page, [question])
  await page.route(`**/api/chat/${THREAD}/stream`, route => route.fulfill({ status: 204 }))
  const sent: unknown[] = []
  await page.route('**/api/chat', async (route) => {
    sent.push(route.request().postDataJSON())
    await fulfillSse(route, replyChunks('Retried answer.'))
  })

  await page.goto(`/?c=${THREAD}`)
  const card = page.locator('[data-testid=chat-interruption]')
  await expect(card).toContainText('no reply')
  await page.screenshot({ path: 'test-results/chat-no-reply-card.png', fullPage: true })

  await page.locator('[data-testid=chat-retry]').click()
  await expect(page.getByText('Retried answer.')).toBeVisible()
  await expect(card).toHaveCount(0)
  expect(sent).toHaveLength(1)
})

test('a reply stopped on the server shows as stopped after reload', async ({ page }) => {
  await login(page)
  await mockThread(page, [
    question,
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Partial answer' }], metadata: { stopped: true } },
  ])
  await page.route(`**/api/chat/${THREAD}/stream`, route => route.fulfill({ status: 204 }))

  await page.goto(`/?c=${THREAD}`)
  await expect(page.locator('[data-testid=chat-interruption]')).toContainText('Reply stopped.')
})
