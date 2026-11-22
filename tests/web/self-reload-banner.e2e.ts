/**
 * The stale-server banner, end to end, against a real host and a real browser.
 *
 * The market updates itself: the files on disk (and so the client bundle the
 * page loads) are new, the server half in the process is still the old one.
 * The page must say so and offer "Apply now"; clicking it must swap the new
 * server half in, reload the page, and leave a market with no banner whose
 * new routes answer.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { landBuild } from './market-build.ts'
import { dshAvailable, dshCommand, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'
import { spawnSync } from 'node:child_process'

const SHOTS = '/tmp/self-reload-shots'

/** reconcileProfile arrived in 0.2.1-rc.1; older hosts have no "Apply now". */
function hostCanSwap(): boolean {
  const command = dshCommand()
  if (command === null) return false
  const probe = spawnSync(command, ['--version'], { shell: true, encoding: 'utf8', timeout: 30_000, cwd: process.env.DSHM_E2E_DSH_CWD })
  const found = /(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/.exec(`${probe.stdout ?? ''}${probe.stderr ?? ''}`)
  if (found === null) return false
  const [major, minor, patch] = [Number(found[1]), Number(found[2]), Number(found[3])]
  if (major > 0 || minor > 2 || (minor === 2 && patch > 1)) return true
  if (minor !== 2 || patch !== 1) return false
  return found[4] === undefined || (found[4] === 'rc' && Number(found[5]) >= 1)
}

describe.skipIf(!dshAvailable() || !hostCanSwap()).sequential('web e2e: "Apply now" after the market updated itself', () => {
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
    newVersion = landBuild(scaffold, 1, { newRoute: '/dsh-market/e2e-banner-new' })
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

  it('shows the banner with "Apply now" in Chinese and English, before anything is clicked', async () => {
    expect((await status()).selfReload).toBe(true)
    expect((await status()).version).not.toBe(newVersion)
    for (const [locale, button, file] of [['zh-CN', '立即生效', 'banner-zh.png'], ['en-US', 'Apply now', 'banner-en.png']] as const) {
      const page = await openMarket(locale)
      try {
        const banner = page.locator('[data-dshm-stale-server]')
        await banner.waitFor({ timeout: 30_000 })
        await banner.getByRole('button', { name: button }).waitFor({ timeout: 10_000 })
        await banner.scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(SHOTS, file) })
      } finally { await page.context().close() }
    }
  }, 300_000)

  it('applies in place: the page reloads, the banner is gone, the new server half answers', async () => {
    const page = await openMarket('en-US')
    const errors = watchConsole(page)
    try {
      const banner = page.locator('[data-dshm-stale-server]')
      await banner.waitFor({ timeout: 30_000 })
      const reloaded = page.waitForEvent('load', { timeout: 60_000 })
      await banner.getByRole('button', { name: 'Apply now' }).click()
      await reloaded

      // The server reports the version the page is, so the page stops saying otherwise.
      expect((await status()).version).toBe(newVersion)
      await enterMarket(page)
      expect(await page.locator('[data-dshm-stale-server]').count()).toBe(0)
      const route = await scaffold.api('/dsh-market/e2e-banner-new')
      expect(route.status).toBe(200)
      expect(await route.text()).toBe(`new-build ${newVersion}`)
      expect(errors.errors().filter(text => !/net::|Failed to load resource/.test(text))).toEqual([])
    } finally { await page.context().close() }
  }, 300_000)
})
