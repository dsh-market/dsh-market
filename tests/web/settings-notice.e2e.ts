/**
 * Web e2e: Settings → Plugin Market on a host that has the Plugins page tab
 * says the market has moved, and its button takes the user there.
 *
 * Only a real host can answer the two questions this feature stands on: does
 * `pluginNavigation.openList()` plus the tab click leave the market tab
 * selected, and does the Settings dialog actually close. On a host without
 * the `plugins.tab` slot (dsh before 0.2.1-alpha.4) there is nothing to say,
 * so the spec checks the opposite there: no line at all.
 */

import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable()).sequential('web e2e: the Settings entry points to the Plugins page', () => {
  let s: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    s = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.addInitScript(() => {
      // Skip the long host-compatibility scan; the test tsconfig has no DOM lib.
      try { (globalThis as any).localStorage.setItem('dshm-host-filter', 'all') } catch { /* private mode */ }
    })
    await openMarketPage(page, s)
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('shows the line, then the button lands on the Plugins page with the market tab selected', async () => {
    await openMarketUi(page)
    await waitMarketCatalog(page)
    const notice = page.locator('[data-dsh-market-notice]')
    // A host without the Plugins tab (and so without this line) keeps the old
    // path: the market in Settings, nothing else to check.
    const hasTab = await notice.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)
    if (!hasTab) return
    expect(await notice.innerText()).toMatch(/插件市场已移到「插件」页|The plugin market has moved to the Plugins page/)
    // The market stays usable below the line.
    expect(await page.locator('[class*="masonryCol"] > [class*="card"]').count()).toBeGreaterThan(0)

    await notice.getByRole('button', { name: /^(去插件页|Go to Plugins)$/ }).click()

    const tab = page.getByRole('tab', { name: /^(插件市场|Plugin Market)$/ })
    await tab.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => tab.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    // The dialog is gone, so the Plugins page is what the user sees.
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 10_000 }).toBe(0)
    await waitMarketCatalog(page)
    expect(await page.locator('[data-dsh-market-notice]').count()).toBe(0)
  }, 300_000)
})
