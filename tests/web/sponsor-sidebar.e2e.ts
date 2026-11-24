/**
 * Real-host check: the market page opened from the sidebar shows the sponsors
 * in its header, ModelGo first, and the page loads at all — on DSH 0.2.3 the
 * request gate calls `connection.admit`, and a gate that throws turns every
 * market route into 403 (#1299), so this doubles as the loads-on-admit-hosts
 * guard.
 */
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable()).sequential('web e2e: sponsors in the sidebar market page', () => {
  let s: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    s = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await openMarketPage(page, s)
    await openMarketUi(page)
    await waitMarketCatalog(page)
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('lists the sponsors in the header, first one first, each with its own market link', async () => {
    const links = await page.locator('[data-dsh-market-root]:visible a[rel~="sponsored"]').evaluateAll(
      anchors => anchors.map(a => (a as { href: string }).href),
    )
    expect(links.length).toBeGreaterThan(0)
    expect(links[0]).toContain('modelgo.ai')
    expect(links[0]).toContain('utm_content=market_search')
    if (process.env.DSHM_SHOT !== undefined) await page.screenshot({ path: process.env.DSHM_SHOT })
  }, 120_000)
})
