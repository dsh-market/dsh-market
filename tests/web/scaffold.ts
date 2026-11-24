/**
 * Web e2e scaffold (harness convention): boot a REAL dsh web composition in
 * a throwaway DSH_HOME with the packed market installed, and hand the
 * caller a base url + console tripwire. Playwright is used as a library by
 * the specs; this file owns only the host side.
 *
 * The dsh CLI is resolved from DSHM_E2E_DSH (a full command line, e.g.
 * "node --import tsx/esm /path/to/deepseek-harness/apps/cli/src/bin.ts")
 * or a bare `dsh` on PATH. Without either, specs skip.
 */

import { exec, execSync, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { startBrowseCatalogServer } from './browse-catalog.ts'
import type { BrowseCatalogServer } from './browse-catalog.ts'
import { packFixture, startFixtureRegistry } from './registry.ts'
import type { FixtureRegistry, ServedPackage } from './registry.ts'

// fileURLToPath, not .pathname: on Windows the pathname carries a leading
// slash (`/D:/a/repo`), and resolving that yields a directory that does not
// exist. Node then reports the failure as ENOENT on cmd.exe — the shell it
// never got to run — which is what made the first Windows e2e run look like
// a missing shell rather than a bad cwd.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Working directory for dsh invocations — source launches need their repo
 * root so `--import tsx/esm` resolves; a global dsh doesn't care. */
const DSH_CWD = process.env.DSHM_E2E_DSH_CWD ?? REPO_ROOT

/** The dsh launch command, or null when no dsh is reachable (specs skip). */
export function dshCommand(): string | null {
  const explicit = process.env.DSHM_E2E_DSH
  if (explicit !== undefined && explicit !== '') return explicit
  const probe = spawnSync('dsh', ['--version'], { shell: true, stdio: 'ignore', timeout: 30_000 })
  return probe.status === 0 ? 'dsh' : null
}

/**
 * Whether the e2e specs can run — and, where they are supposed to be
 * ENFORCING something, whether their absence is an error.
 *
 * Skipping is right on a contributor's machine that has no dsh. It is a trap
 * in CI: this lane installs the CLI itself, so if that step ever breaks (a
 * pinned prerelease unpublished, a registry hiccup) every spec would skip and
 * the job would still go green — reporting "e2e passed" for a run that
 * asserted nothing. CI sets DSHM_E2E_REQUIRED=1 to make that loud.
 */
export function dshAvailable(): boolean {
  if (dshCommand() !== null) return true
  if (process.env.DSHM_E2E_REQUIRED === '1') {
    throw new Error(
      'DSHM_E2E_REQUIRED=1 but no dsh CLI is reachable — the e2e lane would have skipped every spec and passed green',
    )
  }
  return false
}

export interface WebScaffold {
  baseUrl: string
  /** Root URL printed for this process launch. Alpha hosts add their process
   * launch token; legacy hosts print the clean root. Never navigate to this
   * URL directly: `openMarketPage` exchanges it outside browser navigation. */
  readonly processLaunchUrl: string
  home: string
  /**
   * `fetch` against this host as a logged-in browser would: the session
   * cookie from the process launch token rides along. Market routes sit
   * behind the host's own login since #603, so a bare Node `fetch` is the
   * anonymous client that fix exists to refuse — use this for every
   * Node-side call, and bare `fetch` only to assert that refusal.
   */
  api(path: string, init?: RequestInit): Promise<Response>
  /** Stop dsh and boot it again on the same DSH_HOME, same port. */
  restart(): Promise<void>
  /**
   * Move a fixture's `latest` dist-tag — an author publishing a release
   * while the user is running the previous one. Throws without fixtures.
   */
  publish(name: string, version: string): void
  close(): Promise<void>
}

/**
 * Read the latest trustworthy process launch URL from dsh's startup log.
 * Older hosts print the plain root; token-authenticated hosts print the same
 * root with a process launch token. Only this scaffold's exact origin/root and
 * exact token shape are accepted, so unrelated output cannot redirect a
 * browser or API request elsewhere.
 */
export function processLaunchUrlFromOutput(baseUrl: string, output: string): string | null {
  let selected: string | null = null
  for (const line of output.split(/\r?\n/u)) {
    const match = /^dsh web:\s+(https?:\/\/\S+)\s*$/u.exec(line)
    if (match === null) continue
    const candidate = trustedProcessLaunchUrl(baseUrl, match[1])
    if (candidate !== null) selected = candidate.href
  }
  return selected
}

/** Retain a parsed launch URL before the rolling diagnostic tail drops it. */
export function createStartupOutputCapture(baseUrl: string, tailLimit = 8192): {
  readonly outputTail: string
  readonly processLaunchUrl: string | null
  push(chunk: Buffer | string): void
} {
  let outputTail = ''
  let pendingLine = ''
  let processLaunchUrl: string | null = null
  return {
    get outputTail() { return outputTail },
    get processLaunchUrl() { return processLaunchUrl },
    push(chunk) {
      const text = chunk.toString()
      const pending = pendingLine + text
      const completeEnd = pending.lastIndexOf('\n')
      if (completeEnd >= 0) {
        const completed = pending.slice(0, completeEnd + 1)
        const selected = processLaunchUrlFromOutput(baseUrl, completed)
        if (selected !== null) processLaunchUrl = selected
        pendingLine = pending.slice(completeEnd + 1)
        const token = processLaunchUrl === null
          ? null
          : new URL(processLaunchUrl).searchParams.get('token')
        // Sanitize a complete line before it can enter the rolling buffer.
        // An incomplete line stays private: truncating raw output first can
        // strand a bare launch-token suffix after its `?token=` prefix falls
        // off the left edge.
        outputTail = (outputTail + redactAuthenticationSecrets(
          completed,
          token === null ? [] : [token],
        )).slice(-tailLimit)
      } else {
        pendingLine = pending
      }
      // A non-newline progress stream must not grow without bound. A valid
      // dsh startup line is small and console.log always terminates it.
      pendingLine = pendingLine.slice(-tailLimit)
    },
  }
}

/** Never put a process launch token or returned session cookie into logs. */
export function redactAuthenticationSecrets(output: string, exactSecrets: readonly string[] = []): string {
  let redacted = output
    .replace(/([?&]token=)[^&\s#"'<>)]{1,}/giu, '$1<redacted>')
    .replace(/(\bset-cookie\s*:\s*[^=;,\s]+)=([^;\r\n]*)/giu, '$1=<redacted>')
    .replace(/(\bcookie\s*:\s*[^=;,\s]+)=([^;\r\n]*)/giu, '$1=<redacted>')
  for (const secret of exactSecrets) {
    if (secret !== '') redacted = redacted.split(secret).join('<redacted>')
  }
  return redacted
}

/** Run cleanup exactly once on failure and rethrow only reconstructed text. */
export async function withFailureCleanup<T>(
  attempt: () => Promise<T>,
  cleanup: () => Promise<void>,
  exactSecrets: readonly string[] = [],
): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    const details = [error instanceof Error ? error.stack ?? error.message : String(error)]
    try {
      await cleanup()
    } catch (cleanupError) {
      details.push('failure cleanup also failed:')
      details.push(cleanupError instanceof Error ? cleanupError.stack ?? cleanupError.message : String(cleanupError))
    }
    throw new Error(redactAuthenticationSecrets(details.join('\n'), exactSecrets))
  }
}

function cleanRootUrl(baseUrl: string): URL {
  const clean = new URL(baseUrl)
  clean.pathname = '/'
  clean.search = ''
  clean.hash = ''
  return clean
}

function trustedProcessLaunchUrl(baseUrl: string, value: string): URL | null {
  try {
    const expected = cleanRootUrl(baseUrl)
    const candidate = new URL(value)
    if (candidate.origin !== expected.origin || candidate.pathname !== '/'
      || candidate.hash !== '' || candidate.username !== '' || candidate.password !== '') return null
    if (candidate.search === '') return candidate
    const entries = [...candidate.searchParams.entries()]
    if (entries.length !== 1 || entries[0]?.[0] !== 'token' || entries[0][1] === '') return null
    return candidate
  } catch {
    return null
  }
}

interface BrowserSeedCookie {
  name: string
  value: string
  url: string
  expires: number
  httpOnly: true
  secure: boolean
  sameSite: 'Strict'
}

export interface ProcessLaunchExchange {
  cookie: BrowserSeedCookie
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u

function returnedSetCookies(headers: Headers): string[] {
  const withSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const exact = withSetCookie.getSetCookie?.()
  if (exact !== undefined && exact.length > 0) return exact
  const combined = headers.get('set-cookie')
  return combined === null ? [] : [combined]
}

/** Extract only a potential value for failure redaction, never for trust. */
function possibleCookieSecret(header: string): string {
  const pair = header.split(';', 1)[0]?.trim() ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) return ''
  const raw = pair.slice(separator + 1).trim()
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
}

function parseSessionCookie(header: string, expected: URL): BrowserSeedCookie {
  if (/[\r\n]/u.test(header)) throw new Error('process launch token exchange returned a multiline Set-Cookie')
  const segments = header.split(';').map(segment => segment.trim())
  const pair = segments.shift() ?? ''
  const separator = pair.indexOf('=')
  if (separator <= 0) throw new Error('process launch token exchange returned a malformed cookie pair')
  const name = pair.slice(0, separator).trim()
  const rawValue = pair.slice(separator + 1).trim()
  const value = rawValue.startsWith('"') && rawValue.endsWith('"')
    ? rawValue.slice(1, -1)
    : rawValue
  if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
    throw new Error('process launch token exchange returned a cookie with unsafe name or value syntax')
  }

  const attributes = new Map<string, string | true>()
  for (const segment of segments) {
    if (segment === '') continue
    const at = segment.indexOf('=')
    const attribute = (at < 0 ? segment : segment.slice(0, at)).trim().toLowerCase()
    const attributeValue = at < 0 ? true : segment.slice(at + 1).trim()
    if (attributes.has(attribute)) throw new Error(`process launch token exchange duplicated ${attribute}`)
    attributes.set(attribute, attributeValue)
  }
  const allowed = new Set(['max-age', 'path', 'expires', 'httponly', 'secure', 'samesite', 'domain'])
  for (const attribute of attributes.keys()) {
    if (!allowed.has(attribute)) throw new Error(`process launch token exchange returned unsupported ${attribute}`)
  }
  if (attributes.has('domain')) throw new Error('process launch token exchange returned a non-host-only cookie')
  if (attributes.get('path') !== '/') throw new Error('process launch token exchange cookie Path was not /')
  if (attributes.get('httponly') !== true) throw new Error('process launch token exchange cookie was not HttpOnly')
  if (attributes.get('samesite') !== 'Strict') throw new Error('process launch token exchange cookie was not SameSite=Strict')
  const secure = attributes.get('secure') === true
  if (attributes.has('secure') && attributes.get('secure') !== true) {
    throw new Error('process launch token exchange cookie Secure was not a flag')
  }
  if (secure !== (expected.protocol === 'https:')) {
    throw new Error('process launch token exchange cookie Secure did not match the origin scheme')
  }
  const maxAge = attributes.get('max-age')
  const maxAgeSeconds = typeof maxAge === 'string' ? Number(maxAge) : Number.NaN
  if (typeof maxAge !== 'string' || !/^\d+$/u.test(maxAge)
    || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('process launch token exchange cookie Max-Age was not positive')
  }
  const expires = attributes.get('expires')
  const expiresAt = typeof expires === 'string' ? Date.parse(expires) : Number.NaN
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('process launch token exchange cookie Expires was not in the future')
  }
  return {
    name,
    value,
    url: expected.href,
    expires: Math.floor(expiresAt / 1000),
    httpOnly: true,
    secure,
    sameSite: 'Strict',
  }
}

/**
 * Exchange the alpha credential entirely through Node fetch. No Playwright
 * request, trace, HAR, page, or browser URL ever observes the launch token or
 * raw Set-Cookie header. Legacy hosts return null without any network call.
 */
export async function exchangeProcessLaunchToken(
  baseUrl: string,
  processLaunchUrl: string,
  fetch_: typeof fetch = fetch,
): Promise<ProcessLaunchExchange | null> {
  const exactSecrets: string[] = []
  try {
    const expected = cleanRootUrl(baseUrl)
    const launch = trustedProcessLaunchUrl(baseUrl, processLaunchUrl)
    if (launch === null) throw new Error('dsh printed an untrusted process launch URL')
    const tokens = launch.searchParams.getAll('token')
    const exactToken = tokens[0] ?? ''
    if (exactToken === '') {
      if (launch.href !== expected.href) throw new Error('legacy dsh startup URL was not the clean root')
      return null
    }
    exactSecrets.push(exactToken)

    const response = await fetch_(launch.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    })
    try {
      const setCookies = returnedSetCookies(response.headers)
      exactSecrets.push(...setCookies.map(possibleCookieSecret).filter(value => value !== ''))
      if (response.status !== 303) {
        throw new Error(`process launch token exchange returned HTTP ${String(response.status)}, expected 303`)
      }
      const location = response.headers.get('location')
      if (location === null) throw new Error('process launch token exchange omitted Location')
      const redirect = new URL(location, launch)
      if (redirect.href !== expected.href) {
        throw new Error(`process launch token exchange redirected outside the clean root: ${redirect.href}`)
      }
      if (setCookies.length !== 1) {
        throw new Error(`process launch token exchange returned ${String(setCookies.length)} Set-Cookie headers`)
      }
      return { cookie: parseSessionCookie(setCookies[0]!, expected) }
    } finally {
      if (!response.bodyUsed) await response.arrayBuffer()
    }
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    throw new Error(`process launch token exchange failed:\n${redactAuthenticationSecrets(detail, exactSecrets)}`)
  }
}

/**
 * Seed only the safely parsed session cookie, then navigate to the clean root.
 * See tests/web/AUTHENTICATED-LANE.md: traces and HAR are forbidden here.
 */
export async function openMarketPage(
  page: Page,
  scaffold: Pick<WebScaffold, 'baseUrl' | 'processLaunchUrl'>,
  fetch_: typeof fetch = fetch,
): Promise<void> {
  const exactSecrets: string[] = []
  try {
    const exchange = await exchangeProcessLaunchToken(scaffold.baseUrl, scaffold.processLaunchUrl, fetch_)
    if (exchange !== null) {
      exactSecrets.push(exchange.cookie.value)
      await page.context().addCookies([exchange.cookie])
    }
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  } catch (error) {
    const launch = trustedProcessLaunchUrl(scaffold.baseUrl, scaffold.processLaunchUrl)
    const token = launch?.searchParams.get('token')
    if (token !== null && token !== undefined) exactSecrets.push(token)
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    throw new Error(`failed to open authenticated dsh market page:\n${redactAuthenticationSecrets(detail, exactSecrets)}`)
  }
}

// Dismiss the onboarding dialogs that cover the shell on a fresh host (#1033).
const START_GATE_BUTTONS = /^(Close|关闭|Continue|继续|Configure later|稍后配置)$/

export async function dismissStartGate(page: Page): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const gate = page.getByRole('button', { name: START_GATE_BUTTONS }).first()
    try {
      // One gate mounts after the one before it is dismissed, so the tail has
      // to outlast that hand-off: at 800 ms this gave up before the preview
      // notes appeared and left their mask up. The e2e specs' own inline copy
      // of this loop already used 3000.
      await gate.waitFor({ timeout: round === 0 ? 2000 : 3000 })
      await gate.click()
    } catch { break }
  }
}

const MARKET_LABEL = /^(插件市场|Plugin Market)$/

export async function enableMarketSettings(scaffold: Pick<WebScaffold, 'api' | 'baseUrl'>): Promise<void> {
  const response = await scaffold.api('/dsh-market/entry-visibility', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: scaffold.baseUrl },
    body: JSON.stringify({ settingsSection: true }),
  })
  if (!response.ok || (await response.json() as { settingsSection?: boolean }).settingsSection !== true) {
    throw new Error(`could not enable the market Settings section in the test profile (HTTP ${response.status})`)
  }
}

/** Open the optional Settings section only when the test needs that surface. */
export async function openMarketSettings(page: Page): Promise<void> {
  await dismissStartGate(page)
  await openSettingsSection(page)
}

async function openSettingsSection(page: Page): Promise<void> {
  const settings = page.getByRole('button', { name: /^(设置|Settings)$/ }).first()
  // A Chinese UI renders this entry as 账号菜单, not 账户菜单: counting
  // role=button on 0.2.1-rc.2 gave 1 and 0 respectively (#1033).
  const account = page.getByRole('button', { name: /^(Account menu|账号菜单)$/ }).first()
  // Wait for whichever door this host version actually mounts — a bare
  // isVisible() on a still-painting shell raced into the wrong branch and
  // left the market never opened (then the catalog wait timed out on empty).
  // Use locator.or (not Promise.race of two waitFors): the loser of a race
  // still rejects at timeout as an unhandled rejection and can fail a later
  // test on hosts that only expose one of the two entries.
  await settings.or(account).waitFor({ state: 'visible', timeout: 30_000 })
  if (await settings.isVisible().catch(() => false)) {
    await settings.click()
  } else {
    // dsh 0.2.1 moved Settings off the sidebar into the account menu
    // (`Settings ⌥⌘,`); the dialog and its Plugin Market section are the same.
    await account.click()
    await page.getByRole('menuitem', { name: /^(设置|Settings)/ }).first().click()
  }
  // The section lives inside the Settings dialog. Scope to it: an earlier
  // market instance can still be in the page underneath, and its controls sit
  // behind the dialog's mask, where a click never lands. Wait for the dialog
  // itself — counting it the instant after the click often saw zero nodes.
  const dialog = page.getByRole('dialog').first()
  const dialogVisible = await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true).catch(() => false)
  const scope = dialogVisible ? dialog : page
  await scope.getByRole('button', { name: MARKET_LABEL }).click()
  // That click is the first one a leftover gate swallows: the entry never
  // opens, and the failure lands later as an empty-catalog wait that reads
  // like the market is broken. Fail at the door instead (#1033). Scoped to the
  // container the click used — an earlier market instance can still sit in the
  // page underneath, and a page-wide locator would be satisfied by it without
  // anything having opened.
  // Presence only: the error boundary renders this attribute too, so a mounted
  // root says the market opened, not that its catalog loaded.
  const mounted = await scope.locator('[data-dsh-market-root]').first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true).catch(() => false)
  if (!mounted) {
    const gateUp = await page.getByRole('button', { name: START_GATE_BUTTONS })
      .first().isVisible().catch(() => false)
    throw new Error(gateUp
      ? 'market root never mounted: a start gate is still up, so the click was swallowed (#1033)'
      : 'market root never mounted: the Plugin Market entry did not open the market')
  }
}

/** Use a visible market entry without changing the user's entry preferences (#1294). */
export async function openMarketUi(page: Page): Promise<void> {
  await dismissStartGate(page)
  const panels = page.getByRole('navigation', { name: /^(Global panels|全局面板)$/ })
  const sidebarMarket = panels.getByRole('button', { name: MARKET_LABEL })
  const plugins = panels.getByRole('button', { name: /^(Plugins|插件)$/ })
  // Hosts that only offer Settings never register either panel row. Allow the
  // market's saved sidebar preference to load before opening a legacy dialog.
  const panelReady = await sidebarMarket.or(plugins).first().waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true, () => false)
  if (!panelReady) {
    await openSettingsSection(page)
    return
  }
  if (await sidebarMarket.isVisible()) {
    await sidebarMarket.click()
    await page.locator('[data-dsh-market-root]:visible').waitFor()
    return
  }
  await plugins.click()
  const panel = page.locator('[data-plugin-panel]:visible')
  await panel.and(page.locator('[aria-busy="false"]')).waitFor()
  const marketTab = panel.getByRole('tab', { name: MARKET_LABEL })
  if (!await marketTab.isVisible()) {
    // Some hosts have a native Plugins page but no market tab. When the
    // optional sidebar shortcut is off, Settings is still a valid entry.
    await openSettingsSection(page)
    return
  }
  await marketTab.click()
  await panel.locator('[data-dsh-market-plugins-tab="true"]').waitFor({ state: 'visible' })
}

/**
 * Discover is ready when the search box is up — that node only mounts after
 * a successful catalog fetch. loadFail mounts neither search nor cards, so
 * waiting on masonry alone spent the full timeout on a permanent empty state.
 */
export async function waitMarketCatalog(
  page: Page,
  options: { timeout?: number; cards?: boolean } = {},
): Promise<void> {
  const timeout = options.timeout ?? 60_000
  const wantCards = options.cards !== false
  const search = page.getByPlaceholder(/搜索插件|Search plugins/)
  const loadFail = page.getByText(/插件目录加载失败|The plugin catalog failed to load/)
  const deadline = Date.now() + timeout
  for (;;) {
    if (await loadFail.isVisible().catch(() => false)) {
      const detail = (await loadFail.textContent().catch(() => null))?.trim() ?? 'loadFail'
      throw new Error(`market catalog failed to load: ${detail}`)
    }
    if (await search.isVisible().catch(() => false)) break
    if (Date.now() >= deadline) {
      throw new Error(`market catalog did not become ready within ${String(timeout)}ms (no search box)`)
    }
    await page.waitForTimeout(200)
  }
  if (wantCards) {
    const remaining = Math.max(5_000, deadline - Date.now())
    await page.waitForSelector('[class*="masonryCol"] > [class*="card"]', { timeout: remaining })
  }
}

export interface ScaffoldOptions {
  /**
   * Fixture directories under `tests/web/fixtures` to publish to a local
   * npm registry and list in a curated catalog the market is pointed at.
   * With this set the specs can drive the REAL install route end to end.
   *
   * `{ dir, version }` publishes the same fixture directory again under a
   * different version, which is how a spec gets something to update TO. The
   * last entry for a name is the registry's `latest`.
   */
  fixtures?: (string | { dir: string; version: string; manifest?: Record<string, unknown> })[]
  /**
   * Point `DSHM_REGISTRY_URL` at a loopback catalog shaped for the browse
   * lane. Defaults to on when `fixtures` is omitted — without this the UI
   * specs refetch the live megabyte catalog and flake on slow CI links
   * (loading/loadFail render neither search nor cards). Pass `false` only
   * for a probe that deliberately needs today's live shapes.
   */
  localCatalog?: boolean
  /**
   * Install the market itself from the fixture registry instead of from the
   * packed tarball, and publish it there at each of these versions (the
   * first is installed and is the registry's `latest`; `publish('dshmarket',
   * v)` moves the tag). The versions are the working tree's build with only
   * `version` rewritten, so an update between them swaps real files without
   * changing behavior. A tarball-installed market is a `file:` dependency,
   * which the update route rightly refuses to update from a registry.
   * Requires `fixtures`.
   */
  selfVersions?: string[]
  /**
   * Boot the way the official Electron app does: the market's own config names
   * the profile `desktop`, which makes it take its official-desktop branch and
   * drive the host's in-process plugin manager (`ctx.get('pluginManager')`)
   * instead of spawning pnpm. The host refuses to boot a profile called
   * `desktop` itself, so `profiles/desktop` is a symlink to the real `web`
   * profile; the manager acts on the running profile either way.
   */
  officialDesktop?: boolean
}

/**
 * The market's built working tree at another version: unpack the tarball
 * `npm pack` produced, rewrite `version`, pack it again.
 */
function marketAtVersion(tarball: string, destination: string, version: string): ServedPackage {
  const work = join(destination, `market@${version}`)
  mkdirSync(work, { recursive: true })
  execSync(`tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(work)}`, { stdio: 'pipe' })
  const manifestPath = join(work, 'package', 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`)
  const out = join(destination, `market-pack@${version}`)
  mkdirSync(out, { recursive: true })
  // --ignore-scripts: the unpacked copy has no sources to rebuild from.
  execSync(`npm pack --ignore-scripts --pack-destination ${JSON.stringify(out)}`, { cwd: join(work, 'package'), stdio: 'pipe' })
  const file = readdirSync(out).find(entry => entry.endsWith('.tgz'))
  if (file === undefined) throw new Error(`npm pack produced no tarball for the market at ${version}`)
  return { name: String(manifest.name), tarball: join(out, file), manifest: { ...manifest, version } }
}

/**
 * `run` without blocking the event loop. Required for anything that talks to
 * the fixture registry: it is served from THIS process, so a synchronous
 * child would starve it and pnpm would wait for an answer that cannot come.
 */
async function runAsync(command: string, env: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): Promise<void> {
  try {
    await promisify(exec)(command, { env, timeout: 300_000, cwd })
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.slice(-1500) ?? ''
    const stdout = (error as { stdout?: string }).stdout?.slice(-1500) ?? ''
    throw new Error(`${command} failed:\n${stderr}${stdout}`, { cause: error })
  }
}

function run(command: string, env: NodeJS.ProcessEnv, cwd: string = REPO_ROOT): void {
  try {
    execSync(command, { env, stdio: 'pipe', timeout: 300_000, cwd })
  } catch (error) {
    // execSync's own message is only "Command failed"; the reason is on stderr.
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().slice(-1500) ?? ''
    const stdout = (error as { stdout?: Buffer }).stdout?.toString().slice(-1500) ?? ''
    throw new Error(`${command} failed:\n${stderr}${stdout}`, { cause: error })
  }
}

/**
 * Ask the OS for a port rather than guessing one.
 *
 * This used to be `3200 + random(500)`, i.e. somewhere in 3200-3699. On
 * Windows that range is not ours to take: 3389 is RDP, and Hyper-V reserves
 * further blocks around it (`netsh interface ipv4 show excludedportrange`).
 * CI drew 3389 and died with `listen EACCES: permission denied`, which reads
 * like a bug in this repo rather than a port we were never allowed to bind.
 *
 * Binding 0 makes the OS pick from what it will actually hand out, so the
 * reserved ranges cannot come up at all. The gap between closing the probe
 * and dsh binding is a race in principle; in practice the OS does not
 * immediately reissue the port it just handed back.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const picked = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (picked === 0) reject(new Error('the OS returned no port'))
        else resolve(picked)
      })
    })
  })
}

/**
 * Pack the working tree and boot `dsh --profile web` on a free port inside
 * a temp DSH_HOME with the market installed from the tarball.
 */
export async function launchMarketScaffold(options: ScaffoldOptions = {}): Promise<WebScaffold> {
  const command = dshCommand()
  if (command === null) throw new Error('no dsh available — set DSHM_E2E_DSH')
  const home = mkdtempSync(join(tmpdir(), 'dshm-e2e-home-'))
  let env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, CI: 'true' }

  // prepack builds lib/ + client and runs the preflight guard. The market's
  // own install resolves from the real npm registry — it has dependencies.
  run('npm pack --pack-destination ' + JSON.stringify(home), env)
  const tarball = join(home, readdirSync(home).find(name => name.endsWith('.tgz'))!)
  const selfPackages = (options.selfVersions ?? []).map(version => marketAtVersion(tarball, home, version))
  if (selfPackages.length > 0 && (options.fixtures ?? []).length === 0) throw new Error('selfVersions needs `fixtures` for its registry')
  if (selfPackages.length === 0) run(`${command} plugin --profile web add ${JSON.stringify(tarball)}`, env, DSH_CWD)

  // Only now redirect pnpm at the fixture registry, so the fixtures the
  // specs install go through real resolution without touching the network.
  let registry: FixtureRegistry | null = null
  let browseCatalog: BrowseCatalogServer | null = null
  if (options.fixtures !== undefined && options.fixtures.length > 0) {
    registry = await startFixtureRegistry([
      ...options.fixtures.map(
        entry => typeof entry === 'string' ? packFixture(entry, home) : packFixture(entry.dir, home, entry.version, entry.manifest),
      ),
      ...selfPackages,
    ])
    if (selfPackages.length > 0) {
      registry.setLatest('dshmarket', String(selfPackages[0]!.manifest.version))
      // The market comes from the registry, so its dependency is `^x.y.z`
      // rather than a `file:` path. The profile's .npmrc has to exist first:
      // the machine's own npm registry setting outranks the environment
      // variable here, and would resolve the market from the public registry.
      mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
      writeFileSync(join(home, 'profiles', 'web', '.npmrc'), `registry=${registry.npmUrl}\nminimum-release-age=0\n`)
      await runAsync(`${command} plugin --profile web add dshmarket@${String(selfPackages[0]!.manifest.version)}`,
        { ...env, npm_config_registry: registry.npmUrl }, DSH_CWD)
    }
    writeFileSync(
      join(home, 'profiles', 'web', '.npmrc'),
      // minimum-release-age=0: a fixture "published" seconds ago would
      // otherwise trip pnpm 11's fresh-release hold (#39).
      `registry=${registry.npmUrl}\nminimum-release-age=0\n`,
    )
    // npm_config_registry OUTRANKS .npmrc, and `npm run test:web` puts the
    // caller's registry there — so the file alone silently sends pnpm to the
    // public registry, where a fixture does not exist. Set both.
    // DSHM_NPM_MIRROR as well as the pnpm registry: the market reads package
    // METADATA itself (update checks, #45's publish times) through its own
    // region routing table, which npm_config_registry does not touch. Without
    // it a fixture's update check goes to the public registry, 404s, and the
    // market truthfully reports "no update" for a package that only exists
    // here — a green run that asserted nothing.
    env = {
      ...env,
      DSHM_REGISTRY_URL: registry.catalogUrl,
      npm_config_registry: registry.npmUrl,
      DSHM_NPM_MIRROR: registry.npmUrl.replace(/\/+$/, ''),
    }
  } else if (options.localCatalog !== false) {
    // Browse / settings UI lane: a tiny local catalog so Discover does not
    // depend on GitHub Pages / the catalog npm package answering inside the
    // Playwright wait. Install/update specs pass `fixtures` instead.
    browseCatalog = await startBrowseCatalogServer()
    env = { ...env, DSHM_REGISTRY_URL: browseCatalog.catalogUrl }
  }

  if (options.officialDesktop === true) {
    // After the market is installed: its own `dsh plugin add` writes the
    // patch file, and this entry only adds config to the market's row.
    // Block style, not JSON: the market appends rows to this file when a
    // plugin is switched off, and refuses to append to a top-level flow list.
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
      '- id: dsh-market',
      '  config:',
      '    profile: desktop',
      '',
    ].join('\n'))
    symlinkSync(join(home, 'profiles', 'web'), join(home, 'profiles', 'desktop'), 'dir')
  }

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${String(port)}`

  /** Spawn dsh and wait until the market answers, or explain why it never did.
   * `--no-open` (dsh >= 0.1.0-rc.8) is required here: without it, boot tries
   * to launch a system browser, which on a headless CI runner (confirmed on
   * Windows) left orphaned browser processes and the status endpoint never
   * answering — surfacing as a "dsh boot timeout" with nothing actually
   * wrong in this repo. */
  const boot = async (): Promise<{ child: ChildProcess; processLaunchUrl: string }> => {
    const process_ = spawn(`${command} --profile web --port ${String(port)} --no-open`, {
      shell: true,
      cwd: DSH_CWD,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX only: this exists so the negative-pid kill above can address
      // the whole process group. On Windows it maps to DETACHED_PROCESS —
      // no console at all, which is the very thing #40 had to undo — and
      // buys nothing, since taskkill /T walks the tree by pid.
      detached: process.platform !== 'win32',
    })
    const output = createStartupOutputCapture(baseUrl)
    process_.stdout?.on('data', chunk => { output.push(chunk as Buffer) })
    process_.stderr?.on('data', chunk => { output.push(chunk as Buffer) })
    return await withFailureCleanup(async () => {
      const deadline = Date.now() + 120_000
      let statusReady = false
      for (;;) {
        if (process_.exitCode !== null) {
          throw new Error(`dsh exited ${String(process_.exitCode)}:\n${output.outputTail.slice(-2000)}`)
        }
        if (!statusReady) {
          try {
            const res = await fetch(`${baseUrl}/dsh-market/status`, { signal: AbortSignal.timeout(2000) })
            // 401 is the market answering behind the host's login (#603):
            // mounted, and refusing a client with no session — which this
            // readiness probe is. A host without the login answers 200.
            statusReady = res.ok || res.status === 401
          } catch { /* not up yet */ }
        }
        const processLaunchUrl = output.processLaunchUrl
        if (statusReady && processLaunchUrl !== null) return { child: process_, processLaunchUrl }
        if (Date.now() > deadline) {
          throw new Error(`dsh boot timeout (status=${String(statusReady)}, startup URL=${processLaunchUrl === null ? 'missing' : 'ready'}):\n${output.outputTail.slice(-2000)}`)
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 1000))
      }
    }, async () => { await stop(process_) })
  }

  /**
   * Stop dsh and everything it spawned.
   *
   * `process.kill(-pid)` addresses a process GROUP, which Windows does not
   * have — it throws there, and the fallback kills only the shell wrapper,
   * leaving the real dsh process alive and holding the port. In CI that is
   * a hung job, not a failed one. taskkill /T walks the tree instead.
   */
  const stop = async (process_: ChildProcess): Promise<void> => {
    const pid = process_.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
      return
    }
    try { process.kill(-pid, 'SIGTERM') } catch { process_.kill('SIGTERM') }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500))
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }

  let launched = await withFailureCleanup(
    boot,
    async () => {
      try {
        await registry?.close()
        await browseCatalog?.close()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    },
  )
  let child = launched.child
  let processLaunchUrl = launched.processLaunchUrl
  /** `name=value` of this boot's session cookie; null on a host without the login. */
  let sessionCookie: string | null = null
  const authenticate = async (): Promise<void> => {
    const exchange = await exchangeProcessLaunchToken(baseUrl, processLaunchUrl)
    sessionCookie = exchange === null ? null : `${exchange.cookie.name}=${exchange.cookie.value}`
  }
  await authenticate()

  return {
    baseUrl,
    get processLaunchUrl() { return processLaunchUrl },
    home,
    api: (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers)
      if (sessionCookie !== null) headers.set('cookie', sessionCookie)
      return fetch(`${baseUrl}${path}`, { ...init, headers })
    },
    /**
     * Stop dsh and start it again on the same DSH_HOME. This is the only way
     * to observe what the market's file-level work actually did: the profile
     * is recomposed from disk, so a patch layer that hot-mount never touched
     * takes effect, and a profile the install logic bricked fails to come up
     * at all (the real consequence #122 guards against).
     */
    restart: async () => {
      await stop(child)
      launched = await boot()
      child = launched.child
      processLaunchUrl = launched.processLaunchUrl
      await authenticate()
    },
    publish: (name: string, version: string): void => {
      if (registry === null) throw new Error('no fixture registry — pass `fixtures` to launchMarketScaffold')
      registry.setLatest(name, version)
    },
    close: async () => {
      await registry?.close()
      await browseCatalog?.close()
      await stop(child)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** Fail the spec on any console error — the harness console-tripwire pattern. */
export function watchConsole(page: Page): { errors(): string[] } {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => { errors.push(String(error)) })
  return { errors: () => [...errors] }
}
