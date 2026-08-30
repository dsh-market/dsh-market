/**
 * Real-host check for "点了某个分类，标签就跑到前面来了": a category
 * already inside the collapsed two-row clip must not reshuffle when picked.
 */
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('web e2e: category chip order stays put', () => {
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

  it('leaves an already-visible chip where it was; still rescues a hidden one', async () => {
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /插件市场|Plugin Market/ }).click()
    await page.waitForSelector('[class*="masonryCol"] [class*="card"]', { timeout: 60_000 })

    const chipTexts = async (): Promise<string[]> =>
      page.locator('[class*="catsWrap"] [class*="pill"], [class*="catsWrap"] button').allInnerTexts()

    const before = await chipTexts()
    expect(before.length).toBeGreaterThan(2)
    // The second visible chip (index 1, after "全部"/"All") is comfortably
    // inside the two-row clip — clicking it must not move anything.
    const target = before[1]!.trim()
    await page.getByRole('button', { name: target, exact: true }).click()
    await page.waitForTimeout(400)
    const after = await chipTexts()
    console.log('BEFORE=' + JSON.stringify(before))
    console.log('AFTER=' + JSON.stringify(after))
    expect(after).toEqual(before)

    // Now pick something buried far down the expanded list, then COLLAPSE
    // the row (selecting a chip does not auto-collapse it — expand/collapse
    // is its own toggle). That collapse is where the rescue has to fire, or
    // the just-picked category disappears the moment the row shrinks.
    const toggle = page.locator('[class*="catsToggle"]').first()
    await toggle.click().catch(() => {})
    await page.waitForTimeout(300)
    const expanded = await chipTexts()
    const buried = expanded[expanded.length - 2]?.trim()
    if (buried !== undefined && buried !== '') {
      await page.getByRole('button', { name: buried, exact: true }).click()
      await page.waitForTimeout(200)
      await toggle.click().catch(() => {}) // collapse
      await page.waitForTimeout(400)
      const collapsedAfter = await chipTexts()
      console.log('BURIED=' + buried + ' RESULT=' + JSON.stringify(collapsedAfter))
      expect(collapsedAfter[0]?.trim() === buried || collapsedAfter[1]?.trim() === buried).toBe(true)
    }
  }, 300_000)
})
