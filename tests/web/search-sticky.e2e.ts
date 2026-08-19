/**
 * Real-host check for "这里还是挡住的吧？被吸顶盖住了": the search box sits
 * above the sticky category row in the DOM, with no `position` of its own —
 * .head (title + tabs) lives outside the scroller, so as the search box
 * scrolled it slid up underneath .head's fixed strip and got sliced off
 * mid-scroll instead of disappearing cleanly. Wrapping the search row and
 * the category row in one sticky block (.stickyHead) makes them stick
 * together, so the search box never gets caught mid-clip.
 */
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('web e2e: search box stays with the sticky header', () => {
  let s: WebScaffold, browser: any, page: any
  beforeAll(async () => {
    s = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(s.baseUrl, { waitUntil: 'load' })
    for (let i = 0; i < 6; i++) {
      const b = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await b.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await b.click() } catch { break }
    }
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('parks at a stable y once stuck, and is never partially covered while scrolling', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /插件市场|Plugin Market/ }).click()
    await page.waitForSelector('[class*="grid"] [class*="card"]', { timeout: 60_000 })

    const search = page.locator('[class*="tabSearchRow"] input').first()
    const scroller = page.locator('[class*="_body"]').first()
    const ys: number[] = []
    for (const dy of [0, 20, 40, 80, 200, 600]) {
      // Body-context DOM types (document, HTMLElement) aren't in this
      // config's lib — the callback runs in the browser regardless, so
      // reach `document` through globalThis instead of the bare global.
      await scroller.evaluate((el: any, y: number) => { el.scrollTop = y }, dy)
      await page.waitForTimeout(80)
      const box = await search.boundingBox()
      if (box === null) continue
      ys.push(box.y)
      const topTag = await page.evaluate(({ x, y }: { x: number, y: number }) => {
        const doc = (globalThis as any).document
        const el = doc.elementFromPoint(x, y)
        return el === null ? null : el.tagName
      }, { x: box.x + 10, y: box.y + Math.min(3, box.height / 2) })
      expect(topTag, `input covered/clipped at scrollTop=${dy}`).toBe('INPUT')
    }
    // Once the head has stuck, further scrolling must not move it — a
    // drifting y is the search row sliding away under .head again.
    const stuckYs = ys.slice(2)
    expect(Math.max(...stuckYs) - Math.min(...stuckYs), 'search box should be parked once stuck').toBeLessThan(2)
  })
})
