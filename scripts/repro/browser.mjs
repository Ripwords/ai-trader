// Shared helpers for the browser repro scripts: .env, a logged-in page, psql.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split('\n')
    .map(l => l.match(/^\s*([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
)

export const BASE = `http://localhost:${process.env.WEB_PORT || env.WEB_PORT || 3000}`

const { chromium } = createRequire(resolve(ROOT, 'apps/web/package.json'))('playwright')

export function log(msg) {
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`)
}

export function fail(msg) {
  log(`FAIL: ${msg}`)
  process.exit(1)
}

export function pass(msg) {
  log(`PASS: ${msg}`)
}

export function psql(sql) {
  return execFileSync('docker', [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', env.POSTGRES_USER, '-d', env.POSTGRES_DB, '-tAc', sql,
  ], { cwd: ROOT, encoding: 'utf8' }).trim()
}

export async function loggedInPage({ baseURL = BASE } = {}) {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' })
  const context = await browser.newContext({ baseURL })
  const page = await context.newPage()
  await page.goto('/login')
  await page.fill('[name=password]', env.APP_PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForURL(url => !url.pathname.startsWith('/login'))
  return { browser, context, page }
}

export async function poll(what, fn, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 1000))
  }
  fail(`${what} within ${timeoutMs / 1000} s`)
}

export async function sendChat(page, text) {
  const box = page.locator('textarea').first()
  await box.fill(text)
  await box.press('Enter')
}

/**
 * A TCP proxy in front of the web app whose `cut()` destroys every open
 * connection, the way a proxy timeout or a network switch does. Chromium's
 * offline emulation is no stand-in: it keeps a live stream open and discards
 * the bytes that arrive meanwhile, which no real network does.
 */
export async function cuttableProxy() {
  const target = new URL(BASE)
  const sockets = new Set()
  const server = createServer(client => {
    const upstream = connect(Number(target.port), target.hostname)
    for (const s of [client, upstream]) {
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.on('error', () => {})
    }
    client.pipe(upstream).pipe(client)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    cut: () => { for (const s of sockets) s.destroy() },
    close: () => server.close(),
  }
}
