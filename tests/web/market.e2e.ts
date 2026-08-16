/**
 * Web e2e: the manual pre-release click-through, automated — a REAL dsh web
 * composition with the packed market installed, driven by real Chromium.
 * Mirrors the layer-3 harness convention (playwright as a library inside
 * vitest, serial, console tripwire).
 *
 * Hermetic: catalog data comes from the bundled snapshot when the registry
 * site is unreachable; no plugin installs are performed (those live in the
 * flow and compat lanes). A fresh DSH_HOME boots with the testing notice
 * and the English locale — selectors tolerate both languages.
 */

import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshCommand, launchMarketScaffold, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshCommand() !== null

describe.skipIf(!HAS_DSH)('web e2e: plugin market', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    // A fresh home greets with onboarding dialogs (testing notice, API-key
    // prompt, …); click through whichever appear until none are left.
    const passes = /^(Continue|继续|Configure later|稍后配置)$/
    for (let round = 0; round < 5; round++) {
      const button = page.getByRole('button', { name: passes }).first()
      try {
        await button.waitFor({ timeout: round === 0 ? 30_000 : 3000 })
        await button.click()
      } catch {
        break // no more dialogs
      }
    }
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens Settings → Plugin Market and renders the catalog paginated', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /插件市场|Plugin Market/ }).click()
    await page.waitForSelector('[class*="grid"] [class*="card"]', { timeout: 30_000 })
    const cards = await page.locator('[class*="grid"] [class*="card"]').count()
    // Pagination: a bounded first page (24) instead of the full 400+ catalog,
    // with a numbered pager underneath.
    expect(cards).toBe(24)
    // Numbered pager: primitives Buttons inside the pager row.
    expect(await page.locator('[class*="pager"] button').count()).toBeGreaterThan(0)
  })

  it('search and category filter the grid', async () => {
    const search = page.getByPlaceholder(/搜索插件|Search plugins/)
    const gridNames = () => page.locator('[class*="grid"] [class*="nm"]').allTextContents()

    const beforeSearch = await gridNames()
    await search.fill('memory')
    await page.waitForTimeout(400)
    const searched = await gridNames()
    // Pagination caps the grid at a page, so a broad query can still fill all
    // 24 slots — assert the CONTENT changed instead of the count shrinking.
    expect(searched.length).toBeGreaterThanOrEqual(1)
    expect(searched).not.toEqual(beforeSearch)
    await search.fill('')
    await page.waitForTimeout(200)

    // Category chips are data-driven; click the second chip (first is All).
    // Same reasoning: a big category fills a whole page, so assert on the
    // grid CONTENT changing rather than the count shrinking.
    const beforeCats = await gridNames()
    const chips = page.locator('[class*="catsWrap"] [data-chip="1"]')
    await chips.nth(1).click()
    await page.waitForTimeout(400)
    const categorized = await gridNames()
    expect(categorized.length).toBeGreaterThanOrEqual(1)
    expect(categorized).not.toEqual(beforeCats)
    await chips.nth(0).click() // back to All
  })

  it('the installed tab lists the market itself', async () => {
    await page.getByRole('button', { name: /已安装|Installed/ }).click()
    await expect.poll(
      async () => page.locator('[class*="irow"]', { hasText: 'dshmarket' }).count(),
      { timeout: 15_000 },
    ).toBeGreaterThanOrEqual(1)
  })

  it('the install dialog opens and cancels cleanly', async () => {
    // Independent of the previous test's final tab.
    await page.getByRole('button', { name: /^(发现|Discover)$/ }).click()
    await page.waitForSelector('[class*="grid"] [class*="card"]', { timeout: 15_000 })
    await page.getByRole('button', { name: /^(安装|Install)$/ }).first().click()
    const cancel = page.getByRole('button', { name: /^(取消|Cancel)$/ }).first()
    await cancel.waitFor({ timeout: 5000 })
    await cancel.click()
  })

  it('no console errors across the whole journey', () => {
    // GitHub avatars may 404 offline; resource errors surface as console
    // errors with net:: markers — tolerate only those.
    const meaningful = tripwire.errors().filter(text => !/net::|Failed to load resource/.test(text))
    expect(meaningful).toEqual([])
  })
})
