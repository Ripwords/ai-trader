// Measures mobile-layout defects across every route at phone widths.
// Run: node scripts/mobile-audit.mjs [--width 390] [--json out.json]
// Requires the app running on BASE (default http://localhost:3000) and
// APP_PASSWORD in the repo .env for the session cookie.
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const ROUTES = ['/', '/research', '/research/NVDA', '/research/runs', '/research/report/NVDA', '/portfolio', '/algo', '/usage']
const WIDTHS = [320, 390, 430]
const MIN_TAP = 44
const MIN_FONT = 12

function password() {
  if (process.env.APP_PASSWORD) return process.env.APP_PASSWORD
  const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  return env.match(/^APP_PASSWORD=(.*)$/m)?.[1]?.trim() ?? ''
}

const probe = ({ MIN_TAP, MIN_FONT }) => {
  const vw = document.documentElement.clientWidth
  const desc = (el) => {
    const cls = typeof el.className === 'string' ? el.className : ''
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls.trim().split(/\s+/).slice(0, 3).join('.') : ''}`
  }
  const visible = (el) => {
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  // A region the author explicitly made horizontally scrollable (a wide data
  // table, the correlation matrix) is allowed to exceed the viewport, and so
  // is everything inside it. Only the outermost box that escapes the viewport
  // without such an ancestor is a defect.
  const inScrollContainer = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true
    }
    return false
  }

  // Luminance of a computed background once composited over the near-black
  // page. Catches a light-theme component leaking through the dark palette —
  // the failure mode that left the chat composer rendering as a white box.
  //
  // Alpha is the whole game here: a hairline is a 96%-luminance white at 8%
  // opacity, which reads as near-black on screen. Weighting by alpha is what
  // separates it from an actually-white surface.
  const luminance = (c) => {
    const n = c.match(/[\d.]+/g)?.map(Number)
    if (!n) return null
    const oklch = c.startsWith('oklab') || c.startsWith('oklch')
    const alpha = n.length > 3 ? n[3] : 1
    if (alpha === 0) return null
    const base = oklch ? n[0] : (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255
    return base * alpha
  }

  const all = [...document.querySelectorAll('body *')].filter(visible)
  const findings = { overflowX: [], clipped: [], tinyTap: [], tinyFont: [], lightSurface: [] }

  if (document.documentElement.scrollWidth > vw + 1) {
    findings.overflowX.push({ el: 'document', sw: document.documentElement.scrollWidth, vw })
  }

  for (const el of all) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)

    if ((r.right > vw + 1 || r.left < -1) && !inScrollContainer(el)) {
      findings.overflowX.push({ el: desc(el), left: Math.round(r.left), right: Math.round(r.right), vw })
    }

    // Content wider than its own box with no way to scroll it.
    //
    // Measured against in-flow children rather than scrollWidth. scrollWidth
    // reports painted overflow, which includes the absolutely positioned
    // pseudo-elements this codebase uses to widen touch targets on
    // baseline-aligned links — decoration, not content that got truncated.
    // A <select> is exempt too: eliding long option text is what it does.
    const scrollable = /auto|scroll/.test(s.overflowX)
    if (!scrollable && el.tagName !== 'SELECT' && el.clientWidth > 40) {
      const inflow = [...el.children].filter((c) => {
        const p = getComputedStyle(c).position
        return p !== 'absolute' && p !== 'fixed'
      })
      const needed = inflow.length
        ? Math.max(...inflow.map(c => c.getBoundingClientRect().right)) - r.left
        : el.scrollWidth
      if (needed > el.clientWidth + 2) {
        findings.clipped.push({ el: desc(el), needs: Math.round(needed), cw: el.clientWidth })
      }
    }

    const tappable = el.matches('button, a[href], input, select, textarea, [role="button"], [role="tab"]')
    if (tappable) {
      // Clicking a <label> activates the control it wraps, so a small checkbox
      // inside a tall label row is hit through the label, not the box itself.
      const label = el.closest('label')
      const box = label ? label.getBoundingClientRect() : r
      let w = box.width
      let h = box.height

      // A baseline-aligned link cannot grow to 44px without dragging its row,
      // so the codebase widens the touch area with an absolutely positioned
      // pseudo-element instead. That is a real hit target; count it.
      for (const pseudo of ['::after', '::before']) {
        const ps = getComputedStyle(el, pseudo)
        if (ps.content === 'none' || ps.position !== 'absolute') continue
        w = Math.max(w, parseFloat(ps.width) || 0, parseFloat(ps.minWidth) || 0)
        h = Math.max(h, parseFloat(ps.height) || 0, parseFloat(ps.minHeight) || 0)
      }

      if (h < MIN_TAP - 0.5 || w < MIN_TAP - 0.5) {
        findings.tinyTap.push({ el: desc(el), w: Math.round(w), h: Math.round(h), text: (el.textContent || '').trim().slice(0, 24) })
      }
    }

    const fs = parseFloat(s.fontSize)
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
    if (ownText && fs < MIN_FONT && !inScrollContainer(el)) {
      findings.tinyFont.push({ el: desc(el), px: fs, text: (el.textContent || '').trim().slice(0, 24) })
    }

    const lum = luminance(s.backgroundColor)
    if (lum !== null && lum > 0.7 && r.width > 30 && r.height > 12) {
      findings.lightSurface.push({ el: desc(el), bg: s.backgroundColor, w: Math.round(r.width), h: Math.round(r.height) })
    }

  }
  return findings
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.goto(`${BASE}/login`)
const status = await page.evaluate(async (pw) => {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) })
  return r.status
}, password())
if (status !== 200) throw new Error(`login failed: ${status}`)

const report = {}
let total = 0
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 844 })
  for (const route of ROUTES) {
    await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => {})
    await page.waitForTimeout(600)
    const f = await page.evaluate(probe, { MIN_TAP, MIN_FONT })
    const counts = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.length]))
    const n = Object.values(counts).reduce((a, b) => a + b, 0)
    total += n
    report[`${width}${route}`] = { counts, findings: f }
  }
}

for (const [key, { counts }] of Object.entries(report)) {
  const line = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ')
  console.log(`${key.padEnd(34)} ${line || 'clean'}`)
}
console.log(`\nTOTAL ${total}`)

const jsonArg = process.argv.indexOf('--json')
if (jsonArg > -1) writeFileSync(process.argv[jsonArg + 1], JSON.stringify(report, null, 2))

await browser.close()
