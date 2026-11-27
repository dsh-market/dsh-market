/**
 * The stale-server banner, end to end, against a real host and a real browser.
 *
 * The market updates itself: the files on disk (and so the client bundle the
 * page loads) are new, the server half in the process is still the old one.
 * Deferring keeps that process and page running until the next normal start.
 * A user who explicitly confirms an immediate reload can still switch in place.
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hostCanSwap, landBuild } from './market-build.ts'
import { dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const SHOTS = join(tmpdir(), 'self-reload-shots')

describe.skipIf(!dshAvailable() || !hostCanSwap()).sequential('web e2e: activation after the market updated itself', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let newVersion = ''

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true })
    scaffold = await launchMarketScaffold()
    browser = await chromium.launch()
    // A first visit makes the host recompose the profile (start gates, the
    // market's own default settings), and a recompose replaces a market whose
    // files changed. Let that settle BEFORE the update lands, so the update
    // is the only thing that differs afterwards.
    await (await openMarket('en-US')).context().close()
    await new Promise(resolve => setTimeout(resolve, 8000))
    newVersion = await landBuild(scaffold, 1, { newRoute: '/dsh-market/e2e-banner-new' })
  }, 600_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  async function openMarket(locale: string): Promise<Page> {
    const context = await browser.newContext({ locale, viewport: { width: 1200, height: 800 } })
    const page = await context.newPage()
    await openMarketPage(page, scaffold)
    await enterMarket(page)
    return page
  }

  async function enterMarket(page: Page): Promise<void> {
    for (let i = 0; i < 6; i++) {
      const gate = page.getByRole('button', { name: /^(Close|关闭|Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await gate.waitFor({ timeout: i === 0 ? 30_000 : 3000 }); await gate.click() } catch { break }
    }
    // Since 1.79 the market has its own row in the sidebar by default; older
    // defaults reach it through Settings, which openMarketUi still knows.
    const row = page.getByText(/^(插件市场|Plugin Market)$/).first()
    if (await row.waitFor({ timeout: 15_000 }).then(() => true, () => false)) await row.click()
    else await openMarketUi(page)
    await waitMarketCatalog(page, { cards: false })
  }

  const status = async (): Promise<{ version: string; selfReload: boolean }> => (await scaffold.api('/dsh-market/status')).json() as Promise<{ version: string; selfReload: boolean }>

  function watchActivation(page: Page) {
    const activity = { posts: [] as string[], navigations: 0 }
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'POST' && /\/dsh-market\/(?:restart|reload-self)$/.test(path)) activity.posts.push(path)
    })
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) activity.navigations++ })
    return activity
  }

  it('can wait in Chinese and English without interrupting the page, then activates on a normal restart (#1321)', async () => {
    expect((await status()).selfReload).toBe(true)
    const running = (await status()).version
    expect(running).not.toBe(newVersion)
    const cases = [
      ['zh-CN', '重启后生效', '将在下次启动 DeepSeek Harness 时生效。', 'banner-zh.png'],
      ['en-US', 'Apply on next restart', 'Will apply on the next DeepSeek Harness restart.', 'banner-en.png'],
    ] as const
    for (const [locale, label, message, file] of cases) {
      const page = await openMarket(locale)
      try {
        const banner = page.locator('[data-dshm-stale-server]')
        const defer = banner.getByRole('button', { name: label, exact: true })
        await defer.waitFor({ timeout: 30_000 })
        await banner.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(SHOTS, file) })
        const activity = watchActivation(page)
        await defer.click()
        const deferred = banner.getByRole('status')
        await deferred.waitFor()
        expect(await deferred.innerText()).toBe(message)
        expect(await defer.count()).toBe(0)
        expect((await status()).version).toBe(running)
        expect(activity).toEqual({ posts: [], navigations: 0 })
      } finally { await page.context().close() }
    }

    await scaffold.restart()
    expect((await status()).version).toBe(newVersion)
    const page = await openMarket('en-US')
    try {
      expect(await page.locator('[data-dshm-stale-server]').count()).toBe(0)
      const route = await scaffold.api('/dsh-market/e2e-banner-new')
      expect(route.status).toBe(200)
      expect(await route.text()).toBe(`new-build ${newVersion}`)
    } finally { await page.context().close() }
  }, 300_000)

  it('reloads the page and activates a newer build in place only after confirmation', async () => {
    // Let the first visit after the restart finish configuring the profile.
    await new Promise(resolve => setTimeout(resolve, 8000))
    const running = (await status()).version
    const nextVersion = await landBuild(scaffold, 2, { newRoute: '/dsh-market/e2e-banner-confirmed' })
    const page = await openMarket('en-US')
    const errors = watchConsole(page)
    try {
      const banner = page.locator('[data-dshm-stale-server]')
      await banner.waitFor({ timeout: 30_000 })
      const activity = watchActivation(page)
      await banner.getByRole('button', { name: 'Apply now' }).click()
      const confirm = page.getByRole('dialog').getByRole('button', { name: 'Reload market now' })
      await confirm.waitFor()
      expect((await status()).version).toBe(running)
      expect(activity).toEqual({ posts: [], navigations: 0 })
      const reloaded = page.waitForEvent('load', { timeout: 60_000 })
      await confirm.click()
      await reloaded
      expect(activity.posts).toEqual(['/dsh-market/reload-self'])
      expect((await status()).version).toBe(nextVersion)
      await enterMarket(page)
      expect(await page.locator('[data-dshm-stale-server]').count()).toBe(0)
      const route = await scaffold.api('/dsh-market/e2e-banner-confirmed')
      expect(route.status).toBe(200)
      expect(await route.text()).toBe(`new-build ${nextVersion}`)
      expect(errors.errors().filter(text => !/net::|Failed to load resource/.test(text))).toEqual([])
    } finally { await page.context().close() }
  }, 300_000)
})
