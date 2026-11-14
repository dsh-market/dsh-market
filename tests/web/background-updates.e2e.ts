/**
 * #1138: a real host discovers an update while the market is never opened.
 * Automatic checks are opt-in; the enabled startup timer keeps its
 * production 30-second delay. Later explicit
 * POST checks are manual-refresh coverage, not evidence of periodic checks.
 * Everything, including uninstall, runs in the scaffold's disposable home.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import type { Browser, Page, Response as BrowserResponse } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UpdateNotificationSnapshot } from '../../src/update-notifications.ts'
import { dismissStartGate, dshAvailable, launchMarketScaffold, openMarketPage, openMarketUi } from './scaffold.ts'
import type { WebScaffold } from './scaffold.ts'

const HAS_DSH = dshAvailable()
const FIXTURE = 'dshm-e2e-fixture-a'
const ENDPOINT = '/dsh-market/update-notifications'
const INDICATOR = '[data-dsh-market-plugins-indicator]'
const DOT = '[data-dsh-market-update-dot]'
const SCREENSHOTS = process.env.DSHM_E2E_SCREENSHOTS_DIR

describe.skipIf(!HAS_DSH).sequential('web e2e: background update notifications', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let hasPluginsEntry = false
  let initialPluginsText = ''
  const browserChecks: string[] = []
  const indicatorWarnings: string[] = []

  const post = async (path: string, body: unknown): Promise<Response> => scaffold.api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
    body: JSON.stringify(body),
  })
  const snapshot = async (): Promise<UpdateNotificationSnapshot> => {
    const response = await scaffold.api(ENDPOINT)
    expect(response.status).toBe(200)
    return await response.json() as UpdateNotificationSnapshot
  }
  const plugins = () => page.getByRole('button', { name: /^(Plugins|插件)$/ }).first()
  const waitForSnapshotRead = () => page.waitForResponse(response =>
    new URL(response.url()).pathname === ENDPOINT && response.request().method() === 'GET' && response.status() === 200,
  { timeout: 35_000 })
  const expectSeenSnapshotQuiet = async (response: BrowserResponse): Promise<void> => {
    await response.finished()
    const received = await response.json() as UpdateNotificationSnapshot
    expect(received.updates[FIXTURE])
      .toMatchObject({ current: '1.0.0', latest: '2.0.0', updateAvailable: true })
    expect(received.profileKey).toEqual(expect.any(String))
    expect(received.profileKey).not.toBe('')
    await page.locator(INDICATOR).waitFor({ state: 'attached' })
    // A response event fires before the client consumes its body. Observe
    // the mounted decoration through paint and a quiet window so an empty
    // pre-render DOM cannot falsely pass a persisted-receipt assertion.
    const stayedQuiet = await page.evaluate(async selector => {
      const win = globalThis as any
      let appeared = !!win.document.querySelector(selector)
      const observer = new win.MutationObserver(() => {
        if (win.document.querySelector(selector)) appeared = true
      })
      observer.observe(win.document.body, { childList: true, subtree: true })
      await new Promise<void>(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)))
      await new Promise<void>(resolve => win.setTimeout(resolve, 500))
      observer.disconnect()
      return !appeared && !win.document.querySelector(selector)
    }, DOT)
    expect(stayedQuiet).toBe(true)
  }
  const installedVersion = (): string => (JSON.parse(readFileSync(
    join(scaffold.home, 'profiles', 'web', 'node_modules', FIXTURE, 'package.json'), 'utf8',
  )) as { version: string }).version

  beforeAll(async () => {
    scaffold = await launchMarketScaffold({
      fixtures: [
        { dir: 'fixture-a', version: '3.0.0' },
        { dir: 'fixture-a', version: '2.0.0' },
        { dir: 'fixture-a', version: '1.0.0' },
      ],
    })
    const installed = await post('/dsh-market/install', { url: `https://github.com/dshm-e2e/${FIXTURE}` })
    expect(installed.status).toBe(200)
    expect(installedVersion()).toBe('1.0.0')
    scaffold.publish(FIXTURE, '2.0.0')
    // Clear installation state as a fresh launch would. Checks must stay
    // off until the user explicitly enables them below.
    await scaffold.restart()
    const before = await snapshot()
    expect(before.enabled).toBe(false)
    expect(before.intervalHours).toBe(6)
    expect(before.checkedAt).toBeNull()
    expect(before.nextCheckAt).toBeNull()

    browser = await chromium.launch({
      // Optional test-only override for an already-installed local browser.
      // CI continues to use the browser installed by Playwright itself.
      executablePath: process.env.DSHM_E2E_BROWSER_EXECUTABLE || undefined,
    })
    page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
    page.on('console', message => {
      if (/Plugin update indicator/i.test(message.text())) indicatorWarnings.push(message.text())
    })
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      if (path === '/dsh-market/updates' || (path === ENDPOINT && request.method() !== 'GET')) {
        browserChecks.push(`${request.method()} ${path}`)
      }
    })
    // Despite its historical name, this only authenticates and loads the
    // clean app root. Do not call openMarketUi or click Plugins yet.
    await openMarketPage(page, scaffold)
    await dismissStartGate(page)
    // A broken or still-loading old shell must not be mistaken for a host
    // that simply has no Plugins sidebar surface.
    await plugins().or(page.getByRole('button', { name: /^(Settings|设置)$/ }).first())
      .or(page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).first())
      .first().waitFor({ state: 'visible', timeout: 30_000 })
    hasPluginsEntry = await plugins().isVisible()
    if (hasPluginsEntry) initialPluginsText = (await plugins().innerText()).trim()
  }, 600_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('defaults to no automatic checks across the real startup delay', async () => {
    const deadline = Date.now() + 32_000
    while (Date.now() < deadline) {
      const quiet = await snapshot()
      expect(quiet.enabled).toBe(false)
      expect(quiet.intervalHours).toBe(6)
      expect(quiet.nextCheckAt).toBeNull()
      expect(quiet.checkedAt).toBeNull()
      expect(quiet.checking).toBe(false)
      expect(quiet.updates).toEqual({})
      expect(browserChecks).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  })

  it('accepts every interval without silently enabling checks', async () => {
    for (const intervalHours of [6, 12, 72, 168]) {
      const response = await post(ENDPOINT, { intervalHours })
      expect(response.status).toBe(200)
      const saved = await response.json() as UpdateNotificationSnapshot
      expect(saved.intervalHours).toBe(intervalHours)
      expect(saved.enabled).toBe(false)
      expect(saved.nextCheckAt).toBeNull()
      expect(saved.checkedAt).toBeNull()
    }
  })

  it('persists an explicitly enabled switch and selected interval across restart', async () => {
    expect((await post(ENDPOINT, { enabled: true })).status).toBe(200)
    await scaffold.restart()
    const enabled = await snapshot()
    expect(enabled.enabled).toBe(true)
    expect(enabled.intervalHours).toBe(168)
    expect(enabled.checkedAt).toBeNull()
    expect(enabled.nextCheckAt).not.toBeNull()
    await openMarketPage(page, scaffold)
    await dismissStartGate(page)
  })

  it('checks after opt-in startup without a market visit or a manual request, and does not install', async () => {
    await expect.poll(async () => (await snapshot()).updates[FIXTURE], {
      interval: 500, timeout: 120_000,
    }).toMatchObject({ current: '1.0.0', latest: '2.0.0', updateAvailable: true })
    expect(browserChecks).toEqual([])
    const checked = await snapshot()
    expect(checked.checkedAt).not.toBeNull()
    expect(installedVersion()).toBe('1.0.0')
    expect(readFileSync(join(scaffold.home, `e2e-${FIXTURE}.alive`), 'utf8').trim()).toBe('1.0.0')
  })

  it('quietly leaves older hosts without a Plugins entry unchanged', async (context) => {
    if (hasPluginsEntry) context.skip('This host supports the native Plugins sidebar entry')
    expect(await page.locator(INDICATOR).count()).toBe(0)
    expect(await page.locator(DOT).count()).toBe(0)
    expect(indicatorWarnings).toEqual([])
    expect(await page.getByRole('button', { name: /^(Settings|设置)$/ }).first().isVisible()).toBe(true)
  })

  it('clears the dot only after real navigation through the existing Plugins entry', async (context) => {
    // Old CI hosts have only a Settings dialog. The backend test above still
    // runs there; do not misreport a missing sidebar surface as a UI pass.
    if (!hasPluginsEntry) context.skip('This host predates the native Plugins sidebar entry')
    await page.locator(DOT).waitFor({ state: 'visible', timeout: 65_000 })
    expect(await page.locator(INDICATOR).count()).toBe(1)
    expect(await plugins().innerText()).toBe(initialPluginsText)
    expect(Number(await page.locator(DOT).getAttribute('data-update-count'))).toBeGreaterThan(0)
    expect(browserChecks).toEqual([])
    if (SCREENSHOTS) {
      mkdirSync(SCREENSHOTS, { recursive: true })
      // The upper shell shows the native entry and an empty new session;
      // exclude the lower workspace/account area and any browser URL bar.
      await page.screenshot({ path: join(SCREENSHOTS, 'plugins-background-update-dot.png'),
        clip: { x: 0, y: 65, width: 280, height: 170 } })
    }
    // The published host matrix has data-plugin-panel, not data-plugin-body
    // (the latter was added later in the host's source checkout). Assert the
    // actual native page and controls, not a version-specific inner wrapper.
    const panel = page.locator('[data-plugin-panel]:visible')
    expect(await panel.count()).toBe(0)
    // Negative control: a swallowed click must not pass the navigation check.
    // This handler is consumed once; the next click must use the real host.
    await plugins().evaluate(button => button.addEventListener('click', (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }, { capture: true, once: true }))
    await plugins().click()
    await expect(panel.waitFor({ state: 'visible', timeout: 1000 })).rejects.toThrow(/Timeout/)
    expect(await page.locator(DOT).isVisible()).toBe(true)
    await plugins().click()
    await panel.waitFor({ state: 'visible', timeout: 30_000 })
    await panel.getByRole('heading', { name: /^(Plugins|插件)$/, level: 1 })
      .waitFor({ state: 'visible', timeout: 30_000 })
    const refresh = panel.getByRole('button', { name: /^(Refresh|刷新)$/ })
    await refresh.waitFor({ state: 'visible', timeout: 30_000 })
    await expect.poll(() => refresh.isEnabled(), { timeout: 30_000 }).toBe(true)
    await page.locator(DOT).waitFor({ state: 'detached', timeout: 10_000 })
    expect((await snapshot()).updates[FIXTURE]?.updateAvailable).toBe(true)
    expect(indicatorWarnings).toEqual([])
    if (SCREENSHOTS) {
      const nativeMarket = page.getByRole('tab', { name: /^(Plugin Market|插件市场)$/ })
        .or(page.getByRole('button', { name: /^(Plugin Market|插件市场)$/ })).first()
      if (await nativeMarket.isVisible()) await nativeMarket.click()
      else await openMarketUi(page)
      const market = page.locator('[data-dsh-market-root]').first()
      await market.waitFor({ state: 'visible', timeout: 30_000 })
      await market.getByRole('button', { name: /^(Installed|已安装)/ }).first().click()
      const details = market.locator('[data-dsh-market-update-checks]')
      await details.locator('summary').click()
      await details.getByText(FIXTURE, { exact: true }).waitFor({ state: 'visible' })
      await details.getByText(/^(Check for updates automatically|自动检查更新)$/)
        .waitFor({ state: 'visible' })
      // The shared check can arrive before the installed-card listing. Wait
      // for the fixture's card as well, rather than capture its loading gap.
      await market.getByText(FIXTURE, { exact: true }).nth(1)
        .waitFor({ state: 'visible', timeout: 30_000 })
      // Capture the market surface only; a fresh fixture contains no user
      // sessions, and the account/workspace sidebar is outside this image.
      await market.screenshot({ path: join(SCREENSHOTS, 'market-installed-update-checks.png') })
    }
  })

  it('keeps a seen target quiet after leaving, polling, rechecking and reloading', async (context) => {
    if (!hasPluginsEntry) context.skip('This host predates the native Plugins sidebar entry')
    // Prefer direct native panel navigation, without depending on New
    // Session's separate workspace/session selection in a fresh empty home.
    const automation = page.getByRole('button', { name: /^(Automation tasks|自动化任务)$/ }).first()
    if (await automation.isVisible()) {
      await automation.click()
      await page.getByRole('heading', { name: /^(Automation tasks|自动化任务)$/, level: 1 })
        .waitFor({ state: 'visible' })
    } else {
      await page.getByRole('button', { name: /^(New Session|新建会话)$/i }).first().click()
    }
    await page.locator('[data-plugin-panel]:visible').waitFor({ state: 'detached' })
    // Wait for the real client poll, not a mocked event or a test-side GET.
    await expectSeenSnapshotQuiet(await waitForSnapshotRead())
    const response = await post(ENDPOINT, { check: true })
    expect(response.status).toBe(200)
    expect((await response.json() as UpdateNotificationSnapshot).updates[FIXTURE]?.latest).toBe('2.0.0')
    const reloadedSnapshot = waitForSnapshotRead()
    await page.reload({ waitUntil: 'load' })
    await dismissStartGate(page)
    await plugins().waitFor({ state: 'visible' })
    await expectSeenSnapshotQuiet(await reloadedSnapshot)
    expect((await snapshot()).updates[FIXTURE]?.updateAvailable).toBe(true)
  })

  it('keeps the seen update and action available alongside all four polling intervals', async () => {
    if (hasPluginsEntry) {
      await plugins().click()
      await page.locator('[data-plugin-panel]:visible').waitFor({ state: 'visible' })
    }
    const nativeMarket = page.getByRole('tab', { name: /^(Plugin Market|插件市场)$/ })
      .or(page.getByRole('button', { name: /^(Plugin Market|插件市场)$/ })).first()
    if (await nativeMarket.isVisible()) await nativeMarket.click()
    else await openMarketUi(page)
    const market = page.locator('[data-dsh-market-root]').first()
    await market.waitFor({ state: 'visible', timeout: 30_000 })
    await market.getByRole('button', { name: /^(Installed|已安装)/ }).first().click()
    const details = market.locator('[data-dsh-market-update-checks]')
    if (!(await details.evaluate(node => (node as unknown as { open: boolean }).open))) {
      await details.locator('summary').click()
    }
    const updateRow = details.locator('li').filter({ hasText: FIXTURE })
    await updateRow.waitFor({ state: 'visible', timeout: 30_000 })
    expect(await updateRow.innerText()).toMatch(/1\.0\.0\s*→\s*2\.0\.0/)
    expect(await updateRow.getByRole('button', { name: /^(Update|更新)$/ }).isEnabled()).toBe(true)
    if (hasPluginsEntry) expect(await page.locator(DOT).count()).toBe(0)
    const interval = details.getByRole('combobox', { name: /^(Check interval|检查周期)$/ })
    await interval.waitFor({ state: 'visible' })
    expect(await interval.inputValue()).toBe('168')
    expect(await interval.locator('option').evaluateAll(options => options.map(option => ({
      value: (option as unknown as { value: string }).value, text: option.textContent,
    })))).toEqual([
      { value: '6', text: 'Every 6 hours' },
      { value: '12', text: 'Every 12 hours' },
      { value: '72', text: 'Every 3 days' },
      { value: '168', text: 'Every 7 days' },
    ])
    for (const intervalHours of [6, 12, 72, 168]) {
      await interval.selectOption(String(intervalHours))
      await expect.poll(async () => (await snapshot()).intervalHours).toBe(intervalHours)
      expect((await snapshot()).enabled).toBe(true)
    }
    // Selecting a cadence while paused must not opt the user in.
    expect((await post(ENDPOINT, { enabled: false })).status).toBe(200)
    await interval.selectOption('12')
    await expect.poll(async () => (await snapshot()).intervalHours).toBe(12)
    expect((await snapshot()).enabled).toBe(false)
    await interval.selectOption('168')
    await expect.poll(async () => (await snapshot()).intervalHours).toBe(168)
    expect((await snapshot()).enabled).toBe(false)
  })

  it('turns automatic checks off without erasing the available update', async () => {
    const response = await post(ENDPOINT, { enabled: false })
    expect(response.status).toBe(200)
    const disabled = await response.json() as UpdateNotificationSnapshot
    expect(disabled.enabled).toBe(false)
    expect(disabled.intervalHours).toBe(168)
    expect(disabled.nextCheckAt).toBeNull()
    expect(disabled.updates[FIXTURE]?.updateAvailable).toBe(true)
    if (hasPluginsEntry) expect(await page.locator(DOT).count()).toBe(0)
  })

  it('persists the disabled preference over a real host restart', async () => {
    await scaffold.restart()
    await openMarketPage(page, scaffold)
    await dismissStartGate(page)
    const disabled = await snapshot()
    expect(disabled.enabled).toBe(false)
    expect(disabled.intervalHours).toBe(168)
    expect(disabled.nextCheckAt).toBeNull()
    expect(disabled.checking).toBe(false)
    expect(disabled.checkedAt).toBeNull()
    // Cross the real startup delay, polling the read-only endpoint. A
    // forgotten persistence flag would trigger the 30-second check here.
    const deadline = Date.now() + 32_000
    while (Date.now() < deadline) {
      const stillDisabled = await snapshot()
      expect(stillDisabled.enabled).toBe(false)
      expect(stillDisabled.intervalHours).toBe(168)
      expect(stillDisabled.nextCheckAt).toBeNull()
      expect(stillDisabled.checkedAt).toBeNull()
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  })

  it('allows an explicit manual check while automatic checks remain off', async () => {
    const response = await post(ENDPOINT, { check: true })
    expect(response.status).toBe(200)
    const manual = await response.json() as UpdateNotificationSnapshot
    expect(manual.enabled).toBe(false)
    expect(manual.nextCheckAt).toBeNull()
    expect(manual.updates[FIXTURE]).toMatchObject({ current: '1.0.0', latest: '2.0.0', updateAvailable: true })
    expect(installedVersion()).toBe('1.0.0')
    if (hasPluginsEntry) {
      // Reading the same target after a real host restart must not erase the
      // persisted acknowledgement for this profile.
      await expectSeenSnapshotQuiet(await waitForSnapshotRead())
    }
  })

  it('shows the dot for a newly published target while staying outside Plugins', async () => {
    expect(await page.locator('[data-plugin-panel]:visible').count()).toBe(0)
    scaffold.publish(FIXTURE, '3.0.0')
    // Explicit refresh exercises a new release without shortening the real
    // production interval; the startup check above covers automatic wiring.
    const response = await post(ENDPOINT, { check: true })
    expect(response.status).toBe(200)
    expect((await response.json() as UpdateNotificationSnapshot).updates[FIXTURE])
      .toMatchObject({ current: '1.0.0', latest: '3.0.0', updateAvailable: true })
    expect(installedVersion()).toBe('1.0.0')
    if (hasPluginsEntry) await page.locator(DOT).waitFor({ state: 'visible', timeout: 65_000 })
    else {
      expect(await page.locator(INDICATOR).count()).toBe(0)
      expect(indicatorWarnings).toEqual([])
    }
  })

  it('reactively removes an exempted reminder without another registry check', async (context) => {
    if (!hasPluginsEntry) context.skip('This host predates the native Plugins sidebar entry')
    const count = Number(await page.locator(DOT).getAttribute('data-update-count'))
    const checkedAt = (await snapshot()).checkedAt
    const response = await post('/dsh-market/update-exempt', { name: FIXTURE, exempt: true })
    expect(response.status).toBe(200)
    await expect.poll(async () => {
      const dots = page.locator(DOT)
      return await dots.count() === 0 ? 0 : Number(await dots.getAttribute('data-update-count'))
    }, { interval: 500, timeout: 65_000 }).toBe(count - 1)
    const quiet = await snapshot()
    expect(quiet.checkedAt).toBe(checkedAt)
    expect(quiet.updateExempt).toContain(FIXTURE)
    expect(quiet.updates[FIXTURE]?.updateAvailable).toBe(true)
  })

  it('releases the sidebar decoration when this temporary market is uninstalled', async (context) => {
    if (!hasPluginsEntry) context.skip('This host predates the native Plugins sidebar entry')
    const response = await post('/dsh-market/self-uninstall', { confirm: true, purge: false })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    await page.locator(INDICATOR).waitFor({ state: 'detached', timeout: 30_000 })
    expect(await plugins().isVisible()).toBe(true)
    expect((await plugins().innerText()).trim()).toBe(initialPluginsText)
  }, 300_000)
})
