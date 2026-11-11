/**
 * "We installed them": a page built from install tests actually run against a
 * real DSH host (`site/install-tests.json`, produced by the install probe — a
 * clean profile, the market's own install route, the real pnpm and cordis).
 * Nothing on the page is inferred: every row is an outcome that was observed,
 * and the page says which host and market version it was observed on.
 */
import fs from 'node:fs'

export const TESTED_FILE = 'site/install-tests.json'

export function loadTested() {
  try { return JSON.parse(fs.readFileSync(TESTED_FILE, 'utf8')) } catch { return null }
}

export const TESTED_UI = {
  en: {
    navLabel: 'Install tests',
    title: 'We installed the 30 most downloaded DSH plugins — here is what happened — dsh-market',
    desc: 'A clean DSH, the market\'s own install button, the 30 most downloaded plugins. Which ones worked straight away, which needed a restart or your approval, and which need a newer DSH.',
    h1: 'We installed the 30 most downloaded DSH plugins',
    lede: (n, host, date, market) => `On ${date} we installed each of the ${n} most downloaded plugins into an empty profile of DSH ${host}, using dsh-market ${market}, one after another. This page is what we saw — not what the plugin pages say.`,
    sumH: 'The short version',
    sum: (c, n) => [
      `${c.live} of ${n} worked straight away.`,
      c.restart ? `${c.restart} installed fine but need a restart before they take effect.` : '',
      c.builds ? `${c.builds} stopped to ask for your OK to run a build step — one click, then they installed.` : '',
      c['live-error'] ? `${c['live-error']} installed and were running, but the market still showed an error. That is our bug, not theirs.` : '',
    ].filter(Boolean),
    tableH: 'Plugin by plugin',
    cols: { plugin: 'Plugin', result: 'Result', time: 'Time', size: 'Size', older: 'On the older DSH' },
    kinds: {
      live: 'Works now',
      restart: 'Works after a restart',
      builds: 'Asks for your OK first',
      'live-error': 'Running, but an error was shown',
      timeout: 'No answer after 5 minutes',
      failed: 'Failed',
      host: (req) => `Needs DSH ${req} or newer`,
    },
    olderNote: (host) => `DSH ${host}`,
    whyH: 'What the results mean',
    why: [
      ['Works now', 'The plugin was loaded into the running DSH without restarting anything.'],
      ['Works after a restart', 'Installed correctly. DSH has to restart once before it takes effect.'],
      ['Asks for your OK first', 'The plugin depends on a package that wants to run a build step. DSH will not run that without being told. The market shows a button for it; we did not press it, so these were not counted as working.'],
      ['Needs DSH … or newer', 'The plugin only supports newer DSH versions. The market refuses the install and says so, instead of installing something that cannot run.'],
    ],
    caveatH: 'What this does not tell you',
    caveats: [
      'It shows the plugin installs and loads. It does not show that every feature inside works.',
      'Time is the install on one Mac with a warm download cache. Yours will differ.',
      'Size is the plugin folder on disk, without the rest of DSH.',
      'Plugins were installed one after another into the same profile, so one can affect the next. A plugin that failed here may still work on its own.',
    ],
    methodH: 'How we tested',
    method: (host, market) => `Each plugin was installed through the market's own install route on a fresh dsh web profile (DSH ${host}, dsh-market ${market}), using the real pnpm and the real package registry. After each install we waited for the host to settle and read the plugin's state from the host. The same 30 plugins were also installed on the previous DSH release to see who needs the new one. The raw results are in the site repository.`,
    sizeUnit: 'MB', secUnit: 's', repro: 'Dated',
  },
  zh: {
    navLabel: '安装实测',
    title: '我们装了下载量前 30 的 DSH 插件，结果如下 — dsh-market',
    desc: '一个干净的 DSH，用市场自己的安装按钮，装下载量最高的 30 个插件。哪些直接能用，哪些要重启或要你点一下同意，哪些需要更新的 DSH。',
    h1: '我们装了下载量前 30 的 DSH 插件',
    lede: (n, host, date, market) => `${date}，我们在一个空的 DSH ${host} 里，用 dsh-market ${market} 依次安装了下载量最高的 ${n} 个插件。这一页是我们实际看到的，不是插件主页上写的。`,
    sumH: '先说结论',
    sum: (c, n) => [
      `${n} 个里有 ${c.live} 个装完就能用。`,
      c.restart ? `${c.restart} 个装好了，重启一次后生效。` : '',
      c.builds ? `${c.builds} 个停下来问你是否同意运行构建步骤，点一下同意后才会装完。` : '',
      c['live-error'] ? `${c['live-error']} 个已经装好并在运行，但市场还是报了错。这是我们的问题，不是插件的。` : '',
    ].filter(Boolean),
    tableH: '逐个看',
    cols: { plugin: '插件', result: '结果', time: '耗时', size: '体积', older: '在旧版 DSH 上' },
    kinds: {
      live: '装完就能用',
      restart: '重启后生效',
      builds: '先要你点同意',
      'live-error': '已在运行，但报了错',
      timeout: '5 分钟没有回应',
      failed: '没装成',
      host: (req) => `需要 DSH ${req} 或更新`,
    },
    olderNote: (host) => `DSH ${host}`,
    whyH: '结果是什么意思',
    why: [
      ['装完就能用', '插件已加载进正在运行的 DSH，不用重启。'],
      ['重启后生效', '装得没问题，DSH 要重启一次才会生效。'],
      ['先要你点同意', '插件依赖的某个包想运行构建步骤，DSH 没被允许前不会运行。市场里有个按钮可以放行；我们没有点，所以没算作能用。'],
      ['需要 DSH … 或更新', '插件只支持更新的 DSH。市场会拒绝安装并说明原因，不会装一个跑不起来的东西。'],
    ],
    caveatH: '这不能说明什么',
    caveats: [
      '只能说明插件能装、能加载，不能说明里面每个功能都好用。',
      '耗时是在一台 Mac、下载缓存已热的情况下测的，你那边会不一样。',
      '体积是插件自己占的磁盘，不含 DSH 本体。',
      '插件是依次装进同一个配置里的，前一个可能影响后一个。这里没装成的，单独装也许可以。',
    ],
    methodH: '怎么测的',
    method: (host, market) => `每个插件都通过市场自己的安装接口，装进一个全新的 dsh web 配置（DSH ${host}，dsh-market ${market}），用真实的 pnpm 和真实的包仓库。每次装完等宿主稳定，再从宿主读出插件的状态。同样的 30 个插件也在上一版 DSH 上装了一遍，看谁需要新版。原始结果放在站点仓库里。`,
    sizeUnit: 'MB', secUnit: ' 秒', repro: '日期',
  },
}

const fmtMB = (kb) => kb == null ? '—' : kb >= 1024 ? (kb / 1024).toFixed(kb >= 10240 ? 0 : 1) : '&lt;1'

export function testedBody(loc, { data, plugins, esc, pluginPath }) {
  const u = TESTED_UI[loc.code]
  const hosts = Object.keys(data.hosts).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
  const [newer, older] = hosts
  const rows = data.hosts[newer]
  const prev = new Map((data.hosts[older] ?? []).map((r) => [r.npm, r]))
  const byNpm = new Map(plugins.filter((p) => p.npm).map((p) => [p.npm, p]))
  const count = {}
  for (const r of rows) count[r.kind] = (count[r.kind] ?? 0) + 1
  const label = (r) => typeof u.kinds[r.kind] === 'function' ? u.kinds[r.kind](String(r.requires ?? '?').replace(/^[\^>=~\s]+/, '').replace(/\s.*$/, '')) : (u.kinds[r.kind] ?? u.kinds.failed)
  const out = []
  out.push(`<h1>${esc(u.h1)}</h1><p class="lede">${esc(u.lede(rows.length, newer, data.testedAt, data.market))}</p>`)
  out.push(`<h2>${esc(u.sumH)}</h2><ul>${u.sum(count, rows.length).map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)
  out.push(`<h2>${esc(u.tableH)}</h2><div class="tablewrap"><table><tr><th>${esc(u.cols.plugin)}</th><th>${esc(u.cols.result)}</th><th class="n">${esc(u.cols.time)}</th><th class="n">${esc(u.cols.size)} (${u.sizeUnit})</th><th>${esc(u.cols.older)}</th></tr>${rows.map((r) => {
    const p = byNpm.get(r.npm)
    const name = p ? `<a href="${esc(pluginPath(loc, p.slug))}">${esc(p.displayName)}</a>` : esc(r.npm)
    const o = prev.get(r.npm)
    const oldCell = o ? (o.kind === r.kind ? '＝' : esc(label(o))) : '—'
    return `<tr><td>${name}${r.version ? ` <small>${esc(r.version)}</small>` : ''}</td><td>${esc(label(r))}</td><td class="n">${r.secs == null ? '—' : r.secs + u.secUnit}</td><td class="n">${fmtMB(r.sizeKB)}</td><td>${oldCell}</td></tr>`
  }).join('')}</table></div><p><small>${esc(u.cols.older)}: ${esc(u.olderNote(older))}. ＝ same result.</small></p>`)
  out.push(`<h2>${esc(u.whyH)}</h2><ul>${u.why.map(([k, v]) => `<li><strong>${esc(k)}</strong> — ${esc(v)}</li>`).join('')}</ul>`)
  out.push(`<h2>${esc(u.caveatH)}</h2><ul>${u.caveats.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`)
  out.push(`<h2>${esc(u.methodH)}</h2><p>${esc(u.method(newer, data.market))}</p>`)
  return out.join('\n')
}
