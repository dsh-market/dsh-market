/** Real host describe -> plugin tab -> production market card (#516).
 * Desktop services are a non-operational fixture, not an Electron test.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dismissStartGate, dshAvailable, enableMarketSettings, launchMarketScaffold, openMarketPage, openMarketSettings, waitMarketCatalog, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

describe.skipIf(!dshAvailable())('host dispatches the market settings card (#516)', () => {
  let scaffold: WebScaffold
  let browser: Browser

  beforeAll(async () => {
    scaffold = await launchMarketScaffold()
    browser = await chromium.launch()
  }, 300_000)
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  async function checkCard(page: Page, mode: 'web' | 'desktop') {
    const console = watchConsole(page)
    await enableMarketSettings(scaffold)
    await openMarketPage(page, scaffold)
    for (let i = 0; i < 6; i++) {
      const button = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await button.waitFor({ timeout: i === 0 ? 30_000 : 1500 }); await button.click() } catch { break }
    }
    // Newer hosts put Settings in the account menu and the configuration
    // card on the plugin's own page under Plugins.
    const settingsButton = page.getByRole('button', { name: /^(设置|Settings)$/ }).first()
    if (!(await settingsButton.isVisible().catch(() => false))) {
      // 0.2.1's "Get started" gate sits over the whole app on a fresh profile
      // and swallows every click behind it.
      await dismissStartGate(page)
      await page.getByText(/^(Plugins|插件)$/).first().click()
      await page.getByText(/dshmarket/i).first().click()
      const entry = page.getByText(/^(View the plugin market version and settings\.|查看插件市场版本与设置。)$/).first()
      await entry.waitFor({ timeout: 20_000 })
      await entry.click()
      await page.getByText(/^(Update channel|更新通道)$/).waitFor({ timeout: 15_000 })
      await page.getByText(/^(Download region|下载区域)$/).waitFor({ timeout: 15_000 })
      const shot = process.env.DSHM_SETTINGS_ARTIFACTS
      if (shot) await page.screenshot({ path: join(shot, `${mode}-card.png`) })
      // Back to the market's own page: on this line Settings lives in the
      // account menu, and the section is the same one every host serves.
      await openMarketSettings(page)
      await waitMarketCatalog(page, { cards: false })
      const artifacts = process.env.DSHM_SETTINGS_ARTIFACTS
      if (artifacts) await page.screenshot({ path: join(artifacts, `${mode}-market.png`) })
      expect(console.errors().filter(text => !/net::|Failed to load resource/.test(text))).toEqual([])
      return
    }
    await settingsButton.click()

    // Which host generation this is comes from the MARKET — the side that
    // offered its namespace and knows what the service answered (#677).
    // 0.1.7 derives settings from a plugin's Config schema, serves no
    // third-party namespace, and has no plugin-configuration page for this
    // card to be dispatched into. On that host the honest assertion is that
    // the page is gone, not that a card appears on a page that does not
    // exist; asserting either shape unconditionally would demand something a
    // host cannot do, or prove nothing on the host that cannot do it.
    const status = await (await scaffold.api(`/dsh-market/status`)).json() as {
      settingsNamespace?: string
    }
    expect(status.settingsNamespace, 'the market has booted and must have an answer').not.toBe('pending')
    const dispatchesCards = status.settingsNamespace !== 'unsupported-by-host'

    const card = page.locator('button[aria-expanded]').filter({ hasText: /插件市场|Plugin Market/ })
    if (dispatchesCards) {
      await page.getByText(/^(插件|Plugins)$/).last().click()
      await page.getByText(/^(插件配置|Plugin configuration)$/).last().click()
      await card.waitFor({ timeout: 15_000 })
      expect(await card.count()).toBe(1)
      await card.click()
      await page.getByText(/^(下载区域|Download region)$/).waitFor()
      const shot = process.env.DSHM_SETTINGS_ARTIFACTS
      if (shot) await card.locator('..').screenshot({ path: join(shot, `${mode}-card.png`) })
      await page.getByRole('button', { name: /^(Close|关闭)$/ }).first().click()
    } else {
      // The host replaced that page with Config-derived forms and moved a
      // plugin's own configuration onto its bundle's page in the sidebar's
      // Plugins page — its slot contract says where a third-party bundle's
      // configuration belongs, and `plugins.bundle.config` is where this card
      // registers (#677). So the card is asserted THERE, on the seat the host
      // designates, rather than only asserting that the old page is gone.
      await expect(page.getByText(/^(插件配置|Plugin configuration)$/).count()).resolves.toBe(0)
      // Leave Settings first: the sidebar's Plugins entry is the one the page
      // navigates by, and a panel *title* of the same name sits in the way
      // while Settings is open (measured: the click resolves to the title and
      // never becomes stable).
      await page.getByRole('button', { name: /^(Close|关闭)$/ }).first().click()
      await page.waitForTimeout(500)
      await page.getByText(/^(Plugins|插件)$/).first().click()
      await page.getByText(/dshmarket/i).first().click()
      const entry = page.getByText(/^(View the plugin market version and settings\.|查看插件市场版本与设置。)$/).first()
      await entry.waitFor({ timeout: 20_000 })
      await entry.click()
      await page.getByText(/^(Update channel|更新通道)$/).waitFor({ timeout: 15_000 })
      await page.getByText(/^(Download region|下载区域)$/).waitFor({ timeout: 15_000 })
      const shot = process.env.DSHM_SETTINGS_ARTIFACTS
      if (shot) await page.screenshot({ path: join(shot, `${mode}-card.png`) })
    }

    await openMarketSettings(page)
    await waitMarketCatalog(page, { cards: false })
    const artifacts = process.env.DSHM_SETTINGS_ARTIFACTS
    if (artifacts) await page.screenshot({ path: join(artifacts, `${mode}-market.png`) })
    expect(console.errors().filter(text => !/net::|Failed to load resource/.test(text))).toEqual([])
  }

  it('keeps the Web card and dispatches the Desktop card with persisted restart=true', async () => {
    let page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    try { await checkCard(page, 'web') } finally { await page.close() }

    const dir = join(scaffold.home, 'profiles', 'web')
    // An explicit loader dependency orders the fixture services before the
    // real market entry. Package operations cannot run in this fixture.
    writeFileSync(join(dir, 'desktop-settings-fixture.mjs'), `
export function apply(ctx) {
  ctx.provide('desktopProfiles', { current: { name: 'desktop-test', dir: ${JSON.stringify(dir)} } })
  ctx.provide('desktopPnpm', { runPlugin() { throw new Error('package operations forbidden in settings test') } })
}
`)
    writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([
      { insert: [{ id: 'desktop-services-test', name: './desktop-settings-fixture.mjs' }] },
      { id: 'dsh-market', inject: ['desktopProfiles', 'desktopPnpm'], config: { allowRestart: true } },
    ]))
    writeFileSync(join(scaffold.home, 'settings.yaml'), 'dsh-market:\n  allowRestart: true\n')
    await scaffold.restart()
    const status = await (await scaffold.api(`/dsh-market/status`)).json() as { restart: boolean }
    expect(status.restart).toBe(false)
    const capabilities = await (await scaffold.api(`/dsh-market/api/v1/capabilities`)).json()
    expect(capabilities).toMatchObject({
      profile: 'desktop-test', runtime: 'desktop',
      restart: { supported: false, managedBy: 'desktop-host' },
    })
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    try { await checkCard(page, 'desktop') } finally { await page.close() }
  }, 300_000)
})
