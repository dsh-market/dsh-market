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
import type { Browser, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('web e2e: search clear controls and sticky header', () => {
  let s: WebScaffold, browser: Browser, page: Page
  beforeAll(async () => {
    s = await launchMarketScaffold()
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await openMarketPage(page, s)
    for (let i = 0; i < 6; i++) {
      const b = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await b.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await b.click() } catch { break }
    }
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByRole('button', { name: /插件市场|Plugin Market/ }).click()
    await page.waitForSelector('[class*="masonryCol"] [class*="card"]', { timeout: 60_000 })
    // Exercise the Favorites toolbar with an actual saved catalog entry in
    // this throwaway profile, without mocking the host's settings API.
    await page.getByRole('button', { name: /^(加入收藏|Add to favorites)$/ }).first().click()
    await page.getByRole('button', { name: /^(取消收藏|Remove from favorites)$/ }).first().waitFor()
  }, 300_000)
  afterAll(async () => { await browser?.close(); await s?.close() })

  it('parks at a stable y once stuck, and is never partially covered while scrolling', async () => {
    const search = page.locator('[class*="tabSearchRow"] input').first()
    const clear = page.getByRole('button', { name: /^(清除搜索|Clear search)$/ })
    // Whitespace keeps the catalog scrollable while exposing the clear
    // control; a raw nonempty query must remain clearable even if trimmed.
    await search.fill(' ')
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
      expect(await clear.evaluate(button => {
        const box = button.getBoundingClientRect()
        return button.contains(button.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      }), `clear button covered/clipped at scrollTop=${dy}`).toBe(true)
    }
    // Once the head has stuck, further scrolling must not move it — a
    // drifting y is the search row sliding away under .head again.
    const stuckYs = ys.slice(2)
    expect(Math.max(...stuckYs) - Math.min(...stuckYs), 'search box should be parked once stuck').toBeLessThan(2)
    await clear.click()
    expect(await search.inputValue()).toBe('')
    expect(await search.evaluate(input => input === input.ownerDocument.activeElement)).toBe(true)
  })

  it.each(['Enter', 'Space'])('clears with native %s activation and returns typing focus', async key => {
    const search = page.locator('[class*="tabSearchRow"] input').first()
    const clear = page.getByRole('button', { name: /^(清除搜索|Clear search)$/ })
    expect(await clear.count()).toBe(0)
    expect(await search.getAttribute('spellcheck')).toBe('false')

    await search.fill('no-such-plugin-search-clear-524')
    await expect.poll(() => page.locator('[class*="masonryCol"] > [class*="card"]').count()).toBe(0)
    await search.press('Tab')
    expect(await clear.evaluate(button => button === button.ownerDocument.activeElement)).toBe(true)
    const focusStyle = await clear.evaluate(button => {
      const style = button.ownerDocument.defaultView!.getComputedStyle(button)
      return { visible: button.matches(':focus-visible'), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) }
    })
    expect(focusStyle.visible).toBe(true)
    expect(focusStyle.outline).not.toBe('none')
    expect(focusStyle.width).toBeGreaterThan(0)
    await page.keyboard.press(key)
    expect(await search.inputValue()).toBe('')
    expect(await clear.count()).toBe(0)
    expect(await search.evaluate(input => input === input.ownerDocument.activeElement)).toBe(true)
    await expect.poll(() => page.locator('[class*="masonryCol"] > [class*="card"]').count()).toBeGreaterThan(0)
    await page.keyboard.type('next search')
    expect(await search.inputValue()).toBe('next search')
    await clear.click()
  })

  it.each([
    ['Discover', /^(发现|Discover)$/],
    ['Favorites', /^(收藏|Favorites)( \(\d+\))?$/],
    ['Themes', /^(主题|Themes)$/],
    ['Installed', /^(已安装|Installed)( \(\d+\))?$/],
  ] as const)('keeps the %s clear control accessible beside long text in narrow windows', async (_tab, name) => {
    await page.getByRole('button', { name }).click()
    const search = page.getByPlaceholder(/搜索插件|Search plugins|搜索收藏|Search favorites/)
    const clear = page.getByRole('button', { name: /^(清除搜索|Clear search)$/ })
    for (const width of [1200, 640]) {
      await page.setViewportSize({ width, height: 800 })
      await search.fill('long-search-text-'.repeat(30))
      expect(await search.getAttribute('spellcheck')).toBe('false')
      expect(await clear.getAttribute('type')).toBe('button')
      const inputLayout = await search.evaluate(input => {
        const box = input.getBoundingClientRect()
        const field = input.closest('[class*="searchField"]')!.getBoundingClientRect()
        const style = input.ownerDocument.defaultView!.getComputedStyle(input)
        return { left: field.left, right: field.right, textRight: box.right - parseFloat(style.paddingRight) }
      })
      const buttonLayout = await clear.evaluate(button => {
        const box = button.getBoundingClientRect()
        const doc = button.ownerDocument
        return {
          left: box.left,
          right: box.right,
          hit: button.contains(doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
        }
      })
      expect(inputLayout.left).toBeGreaterThanOrEqual(0)
      expect(inputLayout.right).toBeLessThanOrEqual(width)
      expect(inputLayout.textRight, 'long text must stop before the clear button').toBeLessThanOrEqual(buttonLayout.left + 1)
      expect(buttonLayout.right).toBeLessThanOrEqual(inputLayout.right + 1)
      expect(buttonLayout.hit, `clear button must be clickable at viewport width ${width}`).toBe(true)
      await clear.click()
      expect(await search.inputValue()).toBe('')
      expect(await clear.count()).toBe(0)
      expect(await search.evaluate(input => input === input.ownerDocument.activeElement)).toBe(true)
    }
    await page.setViewportSize({ width: 1200, height: 800 })
  })
})
