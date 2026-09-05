import { test, expect, type Page } from '@playwright/test'

/**
 * Guards the phone layout. Every assertion here corresponds to a defect that
 * was measured in a real browser before the mobile pass: content escaping the
 * viewport, wide tables clipped instead of scrollable, and Nuxt UI rendering
 * its light palette under our dark one (which is what turned the chat
 * composer into a white box).
 *
 * `scripts/mobile-audit.mjs` is the exhaustive version of this and reports
 * every finding; this spec pins the subset that must never regress in CI.
 */

const PHONE = { width: 390, height: 844 }
const ROUTES = ['/', '/research', '/research/runs', '/portfolio', '/algo', '/usage']

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.fill('input[type=password]', process.env.APP_PASSWORD!)
  await page.click('button[type=submit]')
  await page.waitForURL('**/')
}

test.use({ viewport: PHONE })

test.describe('mobile layout', () => {
  test('no route overflows the viewport horizontally', async ({ page }) => {
    await login(page)
    for (const route of ROUTES) {
      await page.goto(route)
      await page.waitForLoadState('networkidle')
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      expect(scrollWidth, `${route} scrolls sideways`).toBeLessThanOrEqual(clientWidth + 1)
    }
  })

  test('wide tables scroll rather than clip', async ({ page }) => {
    await login(page)
    await page.goto('/usage')
    await page.waitForLoadState('networkidle')

    // Any table wider than its container must sit in a scrollable ancestor.
    const clipped = await page.evaluate(() => {
      const scrollable = (el: Element | null): boolean => {
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(p).overflowX)) return true
        }
        return false
      }
      return [...document.querySelectorAll('table')]
        .filter(t => t.scrollWidth > t.clientWidth + 2 && !scrollable(t.parentElement))
        .map(t => t.className)
    })
    expect(clipped).toEqual([])
  })

  test('renders the dark palette, not Nuxt UI defaults', async ({ page }) => {
    await login(page)
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/dark/)

    // The composer regressed to white when color-mode was left at `system`.
    const lightSurfaces = await page.evaluate(() => {
      const luminance = (c: string): number | null => {
        const n = c.match(/[\d.]+/g)
        if (!n) return null
        if (c.startsWith('oklab') || c.startsWith('oklch')) {
          return n.length > 3 && Number(n[3]) === 0 ? null : parseFloat(n[0])
        }
        const [r, g, b, a] = n.map(Number)
        if (a === 0) return null
        return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255
      }
      return [...document.querySelectorAll('body *')]
        .filter((el) => {
          const lum = luminance(getComputedStyle(el).backgroundColor)
          const r = el.getBoundingClientRect()
          return lum !== null && lum > 0.7 && r.width > 30 && r.height > 12
        })
        .map(el => el.className.toString().slice(0, 60))
    })
    expect(lightSurfaces).toEqual([])
  })

  test('watchlist and conversations are reachable from the drawer', async ({ page }) => {
    await login(page)
    await page.goto('/')
    const rail = page.locator('#shell-drawer-extra')

    // The rail is teleported into the closed drawer, so it is present but not
    // reachable until the drawer opens.
    await expect(rail.getByText('Watchlist')).toBeHidden()
    await page.click('button[aria-label="Toggle navigation"]')
    await expect(rail.getByText('Watchlist')).toBeVisible()
    await expect(rail.getByPlaceholder('search chats')).toBeVisible()
  })
})
