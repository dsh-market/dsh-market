/** Real host + production client: bulk group disclosure and search (#1129). */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi, waitMarketCatalog, watchConsole } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const A = 'dshm-e2e-fixture-a'
const B = 'dshm-e2e-fixture-b'
const COLLAPSE = /^(Collapse all|全部收起|すべて折りたたむ)$/
const EXPAND = /^(Expand all|全部展开|すべて展開)$/
const SCREENSHOTS = process.env.DSHM_E2E_SCREENSHOTS_DIR

describe.skipIf(!dshAvailable()).sequential('web e2e: bulk group controls (#1129)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  const post = async (path: string, body: unknown): Promise<void> => {
    const response = await scaffold.api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
      body: JSON.stringify(body),
    })
    expect(response.status, `fixture setup: ${path}`).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  }
  const market = () => page.locator('[data-dsh-market-root]:visible').last()
  const groupToggles = () => market().locator('[class*="groupHead"] > button[aria-expanded]')
  const screenshot = async (name: string): Promise<void> => {
    if (!SCREENSHOTS) return
    mkdirSync(SCREENSHOTS, { recursive: true })
    await market().screenshot({ path: join(SCREENSHOTS, `${name}.png`) })
  }

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({ fixtures: ['fixture-a', 'fixture-b'] })
    for (const name of [A, B]) {
      await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${name}` })
    }
    for (const [name, members] of [['Daily work', [A]], ['Review', [B]], ['Empty group', []]] as const) {
      await post('/dsh-market/groups', { action: 'create', name })
      if (members.length > 0) await post('/dsh-market/groups', { action: 'set-members', name, members })
    }
    browser = await chromium.launch({ executablePath: process.env.DSHM_E2E_BROWSER_EXECUTABLE || undefined })
    page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: 'light' })
    tripwire = watchConsole(page)
    await openMarketPage(page, scaffold)
    await openMarketUi(page)
    await waitMarketCatalog(page)
    await market().getByRole('button', { name: /^(Installed|已安装|インストール済み)(?:\s.*)?$/ }).click()
    await market().getByRole('button', { name: /^(Groups|分组|グループ)$/ }).click()
    await groupToggles().first().waitFor()
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('collapses every group, reveals search matches, and expands again in light, dark and narrow layouts', async () => {
    const collapse = market().getByRole('button', { name: COLLAPSE })
    const expand = market().getByRole('button', { name: EXPAND })
    const expandedStates = async () => groupToggles().evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-expanded')))
    await expect.poll(expandedStates).toEqual(['true', 'true', 'true'])
    expect(await expand.isDisabled()).toBe(true)
    expect(await collapse.isEnabled()).toBe(true)
    await screenshot('groups-light-expanded')

    await collapse.click()
    await expect.poll(expandedStates).toEqual(['false', 'false', 'false'])
    expect(await collapse.isDisabled()).toBe(true)
    expect(await expand.isEnabled()).toBe(true)
    expect(await market().getByText(A, { exact: true }).count()).toBe(0)
    await screenshot('groups-light-collapsed')

    const search = market().getByPlaceholder(/搜索插件|Search plugins|プラグインを検索/)
    await search.fill('fixture-a')
    await expect.poll(async () => market().getByText(A, { exact: true }).isVisible()).toBe(true)
    await expect.poll(expandedStates).toEqual(['true'])
    expect(await collapse.isDisabled()).toBe(true)
    expect(await expand.isDisabled()).toBe(true)
    expect(await market().getByText(B, { exact: true }).count()).toBe(0)
    await screenshot('groups-search')

    await search.fill('')
    await expect.poll(expandedStates).toEqual(['false', 'false', 'false'])
    await expand.click()
    await expect.poll(expandedStates).toEqual(['true', 'true', 'true'])
    expect(await expand.isDisabled()).toBe(true)

    // A fresh host uses the system theme; change the browser's real media
    // preference rather than injecting a palette or modifying product DOM.
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => page.locator('body').getAttribute('data-ds-dark-theme')).not.toBeNull()
    await screenshot('groups-dark-expanded')
    await page.setViewportSize({ width: 640, height: 900 })
    await collapse.scrollIntoViewIfNeeded()
    for (const button of [collapse, expand]) {
      const box = await button.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(641)
    }
    await collapse.click()
    await expect.poll(expandedStates).toEqual(['false', 'false', 'false'])
    await screenshot('groups-dark-narrow')
    expect(tripwire.errors().filter(text => !/net::|Failed to load resource/.test(text))).toEqual([])
  })
})
