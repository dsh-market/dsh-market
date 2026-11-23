/**
 * Real-host layout guard for the market header in a narrow settings panel.
 *
 * #842: with up to three update buttons in the row, a 640px window squeezed
 * everything — 插件市场 broke onto two lines and each button became a vertical
 * column of single characters, spilling outside the panel. jsdom does not lay
 * out, so only a real browser can catch this; the buttons are injected because
 * a fresh sandbox has nothing to update, and the rules under test are the CSS
 * ones they exercise (the row may wrap; a button keeps its own width).
 *
 * Red path, measured before the fix at a 356px panel: title height 48 (two
 * lines), row scrollWidth 378 > clientWidth 348, last button right edge 618
 * against a panel right edge of 592.
 */
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, enableMarketSettings, launchMarketScaffold, openMarketPage, openMarketSettings, waitMarketCatalog } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

// `.sequential` like every other file in this suite: two market scaffolds at
// once race each other on the same host, and the loser never reaches the
// settings button (measured on 0.1.0-rc.8 in CI).
describe.skipIf(!dshAvailable()).sequential('web e2e: the market header in a narrow panel (#842)', () => {
  let s: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    s = await launchMarketScaffold()
    await enableMarketSettings(s)
    browser = await chromium.launch()
    // Navigate wide first: at 640px the old hosts collapse the settings entry
    // into a rail, so the entry the market is opened from is not reachable
    // (measured on 0.1.0-rc.8). The panel is then narrowed to the width the
    // layout has to survive.
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await openMarketPage(page, s)
    await openMarketSettings(page)
    await waitMarketCatalog(page)
    await page.setViewportSize({ width: 640, height: 800 })
    await page.locator('[data-dsh-market-root]:visible').waitFor()
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('holds the title on one line and keeps the update buttons inside the panel', async () => {
    const measured = await page.locator('[data-dsh-market-root]:visible').evaluate((market: any) => {
      const doc = market.ownerDocument
      const row = market.querySelector('[class$="_titleRow"]')
      // Since the row-order change the actions are a sibling of the title row,
      // both inside the header container; the header, not the title row, is the
      // thing that has to stay inside the panel.
      const header = market.querySelector('[class$="_headTop"]') ?? row
      // Present once #842's grouping landed; on the old markup the buttons were
      // direct children of the row, so both shapes are exercised.
      const group = market.querySelector('[class$="_titleActions"]')
      const labels = ['更新插件市场', '全部更新', '重启前都不再提醒', '立即重启']
      if (group !== null) while (group.firstChild) group.removeChild(group.firstChild)
      for (const label of labels) {
        const b = doc.createElement('button')
        b.textContent = label
        ;(group ?? row).appendChild(b)
      }
      const box = (el: any) => el.getBoundingClientRect()
      const panel = box(market)
      const title = market.querySelector('[class$="_title"]')
      const buttons = [...(group ?? row).children].map(box)
      return {
        titleHeight: title.getBoundingClientRect().height,
        titleSqueezed: title.scrollWidth > title.clientWidth + 1,
        rowOverflow: (header as any).scrollWidth - (header as any).clientWidth,
        beyondPanel: buttons.filter((b: any) => b.right > panel.right + 1).length,
        squeezedButtons: buttons.filter((b: any) => b.width < 40).length,
      }
    })
    // line-height is 24px: a wrapped title is ~48.
    expect(measured.titleHeight).toBeLessThanOrEqual(28)
    expect(measured.titleSqueezed).toBe(false)
    expect(measured.rowOverflow).toBeLessThanOrEqual(1)
    // A button squeezed below 40px is a label broken into a vertical column.
    expect(measured.squeezedButtons).toBe(0)
    expect(measured.beyondPanel).toBe(0)
  }, 300_000)
})
