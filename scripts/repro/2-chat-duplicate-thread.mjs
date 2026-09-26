// Reloading a new chat before its first chunk must not fork a second thread
// when the user sends again.
import { fail, log, loggedInPage, pass, poll, psql, sendChat } from './browser.mjs'

const since = psql('select now()')
const createdSince = `created_at >= '${since}'`
const assistantReplies = () => Number(psql(
  `select count(*) from chat_messages where role = 'assistant' and thread_id in (select id from chat_threads where ${createdSince})`,
))

const { browser, page } = await loggedInPage()
await page.goto('/')
await sendChat(page, 'Reply with one short sentence about Apple.')
await page.waitForTimeout(300)
log(`reloading ${page.url()} before the first chunk`)
await page.reload()

await poll('the first reply was saved', () => assistantReplies() >= 1, 120_000)
await page.waitForTimeout(2000)
await sendChat(page, 'And one more sentence, please.')
await poll('the second reply was saved', () => assistantReplies() >= 2, 120_000)

const threads = Number(psql(`select count(*) from chat_threads where ${createdSince}`))
if (threads !== 1) fail(`${threads} threads created, expected 1 (run this with no other chat activity)`)
pass('one thread across the reload')
await browser.close()
