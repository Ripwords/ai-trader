// A chat reply survives a dropped connection: cut every socket once the reply
// has started, and the same reply completes in place, saved once.
import { cuttableProxy, fail, log, loggedInPage, pass, poll, psql, sendChat } from './browser.mjs'

const marker = `repro-1-${Date.now()}`
const proxy = await cuttableProxy()
const { browser, page } = await loggedInPage({ baseURL: proxy.baseURL })
await page.goto('/')
const words = async () => (await page.locator('body').innerText()).split(/\s+/).length
const before = await words()
await sendChat(page, `${marker}: write a detailed 1200-word essay on the history of the NASDAQ. Do not call any tools.`)

const threadId = await poll('the chat got a thread id', () => new URL(page.url()).searchParams.get('c'), 30_000)
await poll('the reply started', async () => (await words()) > before + 80, 90_000)
log(`thread ${threadId}: the reply is streaming; cutting every connection`)
proxy.cut()

const assistantCount = () =>
  Number(psql(`select count(*) from chat_messages where thread_id = '${threadId}' and role = 'assistant'`))
await poll('the assistant reply was saved', () => assistantCount() > 0, 300_000)
await page.waitForTimeout(3000)
const saved = assistantCount()
if (saved !== 1) fail(`${saved} assistant messages saved, expected 1`)

const text = psql(`select string_agg(p->>'text', ' ') from chat_messages m, jsonb_array_elements(m.content->'parts') p where m.thread_id = '${threadId}' and m.role = 'assistant' and p->>'type' = 'text'`)
const lastWords = text.replace(/[*_#`>]/g, '').trim().split(/\s+/).slice(-3).join(' ')
const body = await page.locator('body').innerText()
if (!body.replace(/\s+/g, ' ').includes(lastWords)) fail(`the page never showed the end of the reply ("${lastWords}")`)
pass(`reply completed in place without a reload, saved once (thread ${threadId})`)
await browser.close()
proxy.close()
