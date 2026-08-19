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
import { dshAvailable, launchMarketScaffold, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()

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
    await page.waitForSelector('[class*="grid"] > [class*="card"]', { timeout: 30_000 })
    // Direct children only: a card with curated screenshots nests a
    // `.cardShots`/`.cardShot` thumbnail strip, and both class names also
    // match the loose `[class*="card"]` substring — counting descendants
    // inflated the total by however many thumbnails were on screen.
    const cards = await page.locator('[class*="grid"] > [class*="card"]').count()
    // Pagination: a bounded first page (24) instead of the full 400+ catalog,
    // with a numbered pager underneath.
    expect(cards).toBe(24)
    // Numbered pager: primitives Buttons inside the pager row.
    expect(await page.locator('[class*="pager"] button').count()).toBeGreaterThan(0)
  })

  it('shows its own version next to the heading', async () => {
    // The point of the feature is that a PHOTO of the screen carries the
    // version, so assert what is actually rendered and visible — a unit
    // test on the state would pass with the element hidden or unmounted.
    const version = page.locator('[class*="titleRow"] [class*="version"]')
    await version.waitFor({ state: 'visible', timeout: 30_000 })
    expect((await version.textContent())?.trim()).toMatch(/^v\d+\.\d+\.\d+/)
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

    // Category chips are data-driven, and so was the assertion that used to
    // live here: it compared the visible grid before and after, which holds
    // only while the chosen category does not happen to own the top of the
    // default sort. It stopped holding the day the live catalog grew past
    // ~1300 entries, and both CI platforms went red on a change that touched
    // none of this.
    //
    // The TOTAL PAGE COUNT is the property that actually defines filtering:
    // narrowing to one category of several must leave fewer pages than "All",
    // whatever today's catalog looks like and whichever chip is second.
    const pages = async (): Promise<number> => {
      const label = await page.locator('[class*="pageInfo"]').first().textContent()
      // "第 3 / 56 页" / "Page 3 of 56" — the last number is the total.
      const numbers = (label ?? '').match(/\d+/gu) ?? []
      return Number(numbers[numbers.length - 1] ?? 0)
    }

    const allPages = await pages()
    expect(allPages).toBeGreaterThan(1)
    const chips = page.locator('[class*="catsWrap"] [data-chip="1"]')
    await chips.nth(1).click()
    await page.waitForTimeout(400)
    const categorized = await gridNames()
    expect(categorized.length).toBeGreaterThanOrEqual(1)
    expect(await pages(), 'a category must hold fewer pages than the whole catalog').toBeLessThan(allPages)
    await chips.nth(0).click() // back to All
    await page.waitForTimeout(400)
    // ...and clearing the filter restores the full catalog, so a chip that
    // silently stuck would not read as a pass.
    expect(await pages()).toBe(allPages)
  })

  it('never lists the market itself in the Installed tab — it manages itself from its own settings card', async () => {
    await page.getByRole('button', { name: /已安装|Installed/ }).click()
    await page.waitForTimeout(1000)
    expect(await page.locator('[class*="irow"]', { hasText: 'dshmarket' }).count()).toBe(0)
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
