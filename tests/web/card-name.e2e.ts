/**
 * The card header, against the browse catalog's compound identity.
 *
 * Live catalogs carry entries like `OpenViking#examples/dsh-memory-plugin`
 * when a repository holds several plugins. The unit spec pins the transform;
 * this pins that a compound identity still renders as a cleaned title — the
 * browse catalog seeds one such name so CI does not depend on today's live
 * listing answering inside the wait.
 *
 * It fails loudly when no compound entry is on screen rather than passing
 * on having checked nothing.
 */

import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('web e2e: card header', () => {
  let s: WebScaffold, browser: any, page: any
  beforeAll(async () => {
    s = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await openMarketPage(page, s)
    for (let i = 0; i < 6; i++) {
      const b = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await b.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await b.click() } catch { break }
    }
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('shows author-and-avatar as one byline under the plugin name', async () => {
    await openMarketUi(page)
    await waitMarketCatalog(page)
    // Walk the grid until a compound identity appears. The title attribute
    // keeps the raw catalog name, so this compares what the card SHOWS
    // against what it is — no dependence on driving the search box.
    let found: { shown: string; identity: string } | null = null
    for (let page_ = 1; page_ <= 12 && found === null; page_++) {
      // Locators rather than page.evaluate: the callback of evaluate runs
      // in the browser but is type-checked against the Node lib, where
      // `document` does not exist.
      const names = page.locator('[class*="masonryCol"] [class*="nmButton"]')
      for (let i = 0; i < await names.count(); i++) {
        const identity = (await names.nth(i).getAttribute('title')) ?? ''
        if (identity.includes('#')) {
          found = { shown: (await names.nth(i).innerText()).trim(), identity }
          break
        }
      }
      if (found === null) {
        const next = page.getByRole('button', { name: /^(下一页|Next|›|»)$/ }).first()
        if (await next.count() === 0) break
        await next.click().catch(() => {})
        await page.waitForTimeout(700)
      }
    }
    await page.screenshot({ path: '/tmp/cards.png' })
    console.log('FOUND=' + JSON.stringify(found))
    expect(found, 'no compound entry was on screen, so nothing was verified').not.toBeNull()
    expect(found!.identity).toContain('#')
    expect(found!.shown, 'the card still shows the catalog identity').not.toContain('#')
    expect(found!.identity.endsWith(found!.shown)).toBe(true)
  }, 300_000)
})
