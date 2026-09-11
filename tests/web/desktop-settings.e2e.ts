/** Real host describe -> plugin tab -> production market card (#516).
 * Desktop services are a non-operational fixture, not an Electron test.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage, watchConsole } from './scaffold.ts'
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
    await openMarketPage(page, scaffold)
    for (let i = 0; i < 6; i++) {
      const button = page.getByRole('button', { name: /^(Continue|继续|Configure later|稍后配置)$/ }).first()
      try { await button.waitFor({ timeout: i === 0 ? 30_000 : 1500 }); await button.click() } catch { break }
    }
    await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click()
    await page.getByText(/^(插件|Plugins)$/).last().click()
    await page.getByText(/^(插件配置|Plugin configuration)$/).last().click()
    const card = page.locator('button[aria-expanded]').filter({ hasText: /插件市场|Plugin Market/ })
    await card.waitFor({ timeout: 15_000 })
    expect(await card.count()).toBe(1)
    await card.click()
    await page.getByText(/^(下载区域|Download region)$/).waitFor()
    const artifacts = process.env.DSHM_SETTINGS_ARTIFACTS
    if (artifacts) await card.locator('..').screenshot({ path: join(artifacts, `${mode}-card.png`) })
    await page.getByText(/^(插件市场|Plugin Market)$/).first().click()
    await page.getByPlaceholder(/搜索插件|Search plugins/).waitFor()
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
    const status = await (await fetch(`${scaffold.baseUrl}/dsh-market/status`)).json() as { restart: boolean }
    expect(status.restart).toBe(false)
    const capabilities = await (await fetch(`${scaffold.baseUrl}/dsh-market/api/v1/capabilities`)).json()
    expect(capabilities).toMatchObject({
      profile: 'desktop-test', runtime: 'desktop',
      restart: { supported: false, managedBy: 'desktop-host' },
    })
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    try { await checkCard(page, 'desktop') } finally { await page.close() }
  }, 300_000)
})
