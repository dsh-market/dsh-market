/** Follow the Settings notice on the real host, through whichever route it supports. */

import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import { compareVersions } from '../../src/updates.ts'
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

  it('keeps Settings usable and leads to the market tab when the host has one', async () => {
    await openMarketUi(page)
    await waitMarketCatalog(page)

    // Read the running host independently of the notice: a missing notice or
    // button on a capable host must fail instead of selecting a fallback.
    const response = await s.api('/dsh-market/registry')
    expect(response.status).toBe(200)
    const { hostVersion } = await response.json() as { hostVersion: string | null }
    assert(typeof hostVersion === 'string', 'expected the running host version')
    const tabSupport = compareVersions(hostVersion, '0.2.1-alpha.4')
    const openListSupport = compareVersions(hostVersion, '0.2.1-rc.3')
    assert(tabSupport !== null && openListSupport !== null, `unrecognised host version: ${hostVersion}`)

    const notice = page.locator('[data-dsh-market-notice]')
    if (tabSupport < 0) {
      expect(await notice.count()).toBe(0)
      return
    }
    const tab = page.getByRole('tab', { name: /^(插件市场|Plugin Market)$/ })
    if (openListSupport < 0) {
      await notice.getByText(/「插件」页的「插件市场」页签|Plugin Market tab on the Plugins page/).waitFor()
      expect(await notice.getByRole('button').count()).toBe(0)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /^(插件|Plugins)$/ }).first().click()
      await tab.click()
    } else {
      await notice.getByText(/已移到「插件」页，|moved to the Plugins page\./).waitFor()
      await notice.getByRole('button', { name: /^(去插件页|Go to Plugins)$/ }).click()
    }

    await tab.waitFor({ state: 'visible', timeout: 15_000 })
    await expect.poll(() => tab.getAttribute('aria-selected'), { timeout: 10_000 }).toBe('true')
    // The dialog is gone, so the Plugins page is what the user sees.
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 10_000 }).toBe(0)
    await waitMarketCatalog(page)
    expect(await page.locator('[data-dsh-market-notice]').count()).toBe(0)
  }, 300_000)
})
