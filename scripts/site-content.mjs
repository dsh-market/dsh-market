/**
 * The original-content half of dshmarket.com: hand-written guides and a
 * data-derived ecosystem report.
 *
 * Why this exists. The site's plugin pages used to be a re-rendering of other
 * people's READMEs, and AdSense rejected it for "low value content". What the
 * market genuinely knows that nobody else publishes is (a) how its own
 * product behaves — the guides are written from the code and the issues users
 * actually filed — and (b) numbers about the catalog it indexes. The report
 * is therefore computed on every build from the catalog snapshot: nothing in
 * it is typed in by hand, so it cannot drift from the data it describes.
 */
import fs from 'node:fs'
import { MIN_PER_CATEGORY } from './site-category.mjs'

export const GUIDES = [
  {
    slug: 'release-age-wait',
    en: { title: 'Why an update says "waiting": the release-age wait', desc: 'A new plugin version is held for a set time before DSH will install it. What the wait is, why it exists, how dsh web and the desktop app differ, and how to change it.' },
    zh: { title: '更新为什么提示「新版等待中」：发布等待期', desc: '新发布的插件版本要等一段时间才允许安装。这段等待是什么、为什么有、dsh web 和桌面端有什么不同，以及怎么调整。' },
  },
  {
    slug: 'plugin-states',
    en: { title: '"Installed, not in effect": what each plugin state means', desc: 'Every status the Installed tab can show — in effect, restart needed, incompatible, library, failed — what it means and what to do about it.' },
    zh: { title: '「已安装，未生效」是什么意思', desc: '「已安装」页可能出现的每一种状态：已生效、重启后生效、不兼容、依赖库、校验未通过……各是什么意思，该怎么办。' },
  },
  {
    slug: 'permission-labels',
    en: { title: 'What the permission labels on a plugin mean', desc: 'Plugin pages list what the code appears to do: read files, use the network, run commands. Each label in plain terms, and what a static scan can and cannot tell you.' },
    zh: { title: '插件页上的权限标签是什么意思', desc: '插件页会列出代码看起来能做什么：读文件、联网、运行命令。每个标签的白话解释，以及静态扫描能说明和不能说明的事。' },
  },
  {
    slug: 'desktop-vs-web',
    en: { title: 'Desktop app or dsh web: where your plugins live', desc: 'The desktop app and dsh web each keep their own plugin list. How to install in each, and why a plugin you installed may seem to be missing.' },
    zh: { title: '桌面端还是 dsh web：你的插件装在哪里', desc: '桌面端和 dsh web 各有一份自己的插件列表。各自怎么安装，以及为什么装了的插件可能看起来不见了。' },
  },
  {
    slug: 'market-stopped',
    en: { title: '"The plugin market stopped running": what happened and what to do', desc: 'Why the market page can report that it stopped after an install or update, what to try in order, and what happened to the operation you were running.' },
    zh: { title: '「插件市场已停止运行」：发生了什么，该怎么办', desc: '为什么安装或更新之后，市场页面会提示它停了；按什么顺序试；以及你刚才那次操作的结果在哪里。' },
  },
]

export const UI = {
  en: {
    navGuides: 'Guides', navReport: 'Ecosystem report',
    guidesTitle: 'Guides for DSH plugins — dsh-market',
    guidesH1: 'Guides', guidesDesc: 'Short, practical explanations of how DSH plugins install, update and behave, written from the problems people actually run into.',
    guidesLede: 'How the market and DSH behave, and what to do when something looks wrong. Each guide answers one question.',
    reportTitle: 'The DSH plugin ecosystem in numbers — dsh-market',
    reportDesc: 'How many DSH plugins exist, how fast the catalog grows, which categories dominate, how concentrated installs are, and what plugins ask to do. Computed from the catalog on every rebuild.',
    home: 'Home', updatedOn: 'Catalog data as of',
  },
  zh: {
    navGuides: '使用指南', navReport: '生态报告',
    guidesTitle: 'DSH 插件使用指南 — dsh-market',
    guidesH1: '使用指南', guidesDesc: '用大白话讲清楚 DSH 插件怎么安装、更新、为什么这样表现，内容来自大家真正遇到过的问题。',
    guidesLede: '市场和 DSH 是怎么工作的，以及看起来不对劲时该怎么办。每篇只回答一个问题。',
    reportTitle: 'DSH 插件生态数据报告 — dsh-market',
    reportDesc: 'DSH 插件有多少、目录增长多快、哪些分类最多、安装集中在哪、插件会要求做什么。每次重建都从目录数据重新计算。',
    home: '首页', updatedOn: '目录数据截至',
  },
}

export const guideBody = (slug, loc) => fs.readFileSync(`site/guides/${slug}.${loc.code}.html`, 'utf8')

const T = {
  en: {
    h1: 'The DSH plugin ecosystem, in numbers',
    lede: (n, date) => `${n} plugins are in the catalog as of ${date}. Every figure on this page is computed from the catalog data each time the site rebuilds; none of it is typed in by hand.`,
    growthH: 'How fast the catalog is growing',
    growthP: (first, total) => `The catalog has been collecting entries since ${first}. "Added" is the day an entry joined the catalog, not the day the plugin was written, so a plugin that existed earlier shows up when it was found. All ${total} entries are counted below.`,
    month: 'Month added', count: 'Entries', partial: '(month in progress)',
    catH: 'Where the plugins are',
    catP: (days) => `Share of the catalog by category, how many entries each gained in the last ${days} days, and the most-downloaded plugin in it.`,
    cat: 'Category', plugins: 'Plugins', share: 'Share', recent: 'Added, last 30 days', top: 'Most downloaded',
    concH: 'Downloads are concentrated in a few plugins',
    concP: (w, withDl, n) => `${withDl} of ${n} plugins publish an npm download count; the figures are downloads over the 30 days to ${w}.`,
    concTop10: (pct) => `The ten most-downloaded plugins account for <b>${pct}%</b> of all those downloads.`,
    concTop100: (pct) => `The top hundred account for <b>${pct}%</b>.`,
    concMedian: (m, p90) => `The median plugin has <b>${m}</b> downloads; one in ten has more than <b>${p90}</b>. npm counts include automated traffic such as mirrors and CI, so read them as relative size, not as the number of people using a plugin.`,
    concNone: (k, n) => `<b>${k}</b> of ${n} entries have no download figure: they are not published to npm, or the count is not available yet. GitHub-only plugins install straight from a repository.`,
    npmShare: (k, pct) => `<b>${k}</b> entries (${pct}%) are published to npm.`,
    capH: 'What plugins ask to do',
    capP: (scanned, total, date) => `The catalog statically scans each plugin's published code. ${scanned} of ${total} entries have been scanned (latest scan ${date}). The table shows how many of those contain each kind of call.`,
    capNote: '"Not detected" never means "safe": a static scan cannot see code built at runtime or fetched later. These are things to look at, not verdicts. See <a href="__GUIDE_permission-labels__">what the labels mean</a>.',
    capLabel: 'What the code does', capCount: 'Plugins', capPct: 'Of scanned',
    capNames: {
      'fs-read': 'Reads files on this machine', 'fs-write': 'Writes files on this machine', 'network': 'Uses the network',
      'env': 'Reads environment variables', 'shell': 'Can run commands', 'credentials': 'Uses your keys',
      'llm': 'Calls an AI model', 'host-runtime': 'Uses DSH internal packages', 'dynamic-code': 'Runs code assembled at runtime', 'subagent': 'Starts tasks on its own',
    },
    capNone: (k, pct) => `<b>${k}</b> scanned plugins (${pct}%) showed none of the above.`,
    capKeys: (k, pct) => `<b>${k}</b> plugins (${pct}% of those scanned) both use the network and read keys or credentials. That is what a plugin that calls a model has to do, so it is the most common finding rather than a warning sign.`,
    capInstall: (k) => `<b>${k}</b> plugins ship a script that runs at install time, before you open the plugin. These are the ones worth reading first.`,
    methodH: 'How this was computed',
    methodP: (src) => `Source: the catalog at ${src}, the same list that powers the market. Percentages use the stated denominator and are rounded to one decimal place. The figures change as the catalog does; the page is rebuilt every day.`,
  },
  zh: {
    h1: 'DSH 插件生态：用数据看全貌',
    lede: (n, date) => `截至 ${date}，目录里共有 ${n} 个插件。本页的每个数字都在站点重建时从目录数据重新算出，没有一个是手写的。`,
    growthH: '目录增长有多快',
    growthP: (first, total) => `目录从 ${first} 开始收录。「收录」指条目进入目录的那一天，不是插件写成的那一天，所以更早就存在的插件，是在被发现时才出现。下面统计了全部 ${total} 个条目。`,
    month: '收录月份', count: '条目数', partial: '（本月进行中）',
    catH: '插件都集中在哪',
    catP: (days) => `各分类占目录的比例、近 ${days} 天各分类新增了多少条目，以及这个分类里下载量最高的插件。`,
    cat: '分类', plugins: '插件数', share: '占比', recent: '近 30 天新增', top: '下载量最高的',
    concH: '下载集中在少数几个插件',
    concP: (w, withDl, n) => `${n} 个插件里有 ${withDl} 个公布了 npm 下载量；数字是截至 ${w} 的近 30 天下载量。`,
    concTop10: (pct) => `下载最多的十个插件，占这些下载量的 <b>${pct}%</b>。`,
    concTop100: (pct) => `前一百名占 <b>${pct}%</b>。`,
    concMedian: (m, p90) => `中位数的插件有 <b>${m}</b> 次下载；每十个里有一个超过 <b>${p90}</b>。npm 的数字包含镜像、CI 等自动流量，请当作相对大小来看，不要当成使用人数。`,
    concNone: (k, n) => `${n} 个条目里有 <b>${k}</b> 个没有下载量：它们没有发布到 npm，或者数字暂时还拿不到。只在 GitHub 上的插件直接从仓库安装。`,
    npmShare: (k, pct) => `<b>${k}</b> 个条目（${pct}%）发布在 npm 上。`,
    capH: '插件会要求做什么',
    capP: (scanned, total, date) => `目录会对每个插件发布出来的代码做静态扫描。${total} 个条目里已经扫描了 ${scanned} 个（最近一次扫描是 ${date}）。下表是其中包含各类调用的数量。`,
    capNote: '「没有扫描到」从不等于「安全」：静态扫描看不到运行时才拼出来的代码，也看不到之后才下载的代码。这些是该看哪里的提示，不是结论。见<a href="__GUIDE_permission-labels__">标签是什么意思</a>。',
    capLabel: '代码会做什么', capCount: '插件数', capPct: '占已扫描',
    capNames: {
      'fs-read': '会读取本机文件', 'fs-write': '会写入本机文件', 'network': '会联网',
      'env': '会读环境变量', 'shell': '能运行命令', 'credentials': '会用你的密钥',
      'llm': '会调用 AI 模型', 'host-runtime': '用到 DSH 宿主内部的包', 'dynamic-code': '会在运行时执行拼出来的代码', 'subagent': '会自己开任务干活',
    },
    capNone: (k, pct) => `已扫描的插件里有 <b>${k}</b> 个（${pct}%）以上几项都没出现。`,
    capKeys: (k, pct) => `<b>${k}</b> 个插件（占已扫描的 ${pct}%）既会联网，又会读密钥。调用模型的插件必然如此，所以这是最常见的发现，不是警示信号。`,
    capInstall: (k) => `<b>${k}</b> 个插件带有安装时就运行的脚本，在你打开插件之前就会执行。这些最值得先读一遍。`,
    methodH: '数据是怎么算的',
    methodP: (src) => `来源：${src} 上的目录，也就是驱动这个市场的同一份列表。百分比使用文中写明的分母，保留一位小数。数字会随目录变化，页面每天重建。`,
  },
}

export const CAP_NAMES = { en: T.en.capNames, zh: T.zh.capNames }

const fmt = (n) => new Intl.NumberFormat('en-US').format(n)
const pct = (a, b) => (b === 0 ? '0' : (Math.round((a / b) * 1000) / 10).toFixed(1))
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return 0
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * The ecosystem report body for one locale. Pure: the same snapshot gives the
 * same page, which is what lets the sitemap's lastmod be the data's date.
 */
export function reportBody(loc, { plugins, registry, catName, esc, pluginPath, catalog, categoryPath }) {
  const t = T[loc.code]
  const date = registry.updated ?? ''
  const out = []
  out.push(`<h1>${esc(t.h1)}</h1>`)
  out.push(`<p class="lede">${esc(t.lede(fmt(plugins.length), date))}</p>`)

  // Growth
  const byMonth = new Map()
  for (const p of plugins) {
    const m = String(p.added ?? '').slice(0, 7)
    if (/^\d{4}-\d{2}$/.test(m)) byMonth.set(m, (byMonth.get(m) ?? 0) + 1)
  }
  const months = [...byMonth.keys()].sort()
  if (months.length) {
    const peak = Math.max(...byMonth.values())
    const last = months.at(-1)
    out.push(`<h2>${esc(t.growthH)}</h2><p>${esc(t.growthP(months[0], fmt(plugins.length)))}</p>`)
    out.push(`<div class="tablewrap"><table><tr><th>${esc(t.month)}</th><th class="n">${esc(t.count)}</th><th></th></tr>${months.map((m) => {
      const n = byMonth.get(m)
      return `<tr><td>${m}${date.startsWith(m) && m === last ? ` ${esc(t.partial)}` : ''}</td><td class="n">${fmt(n)}</td><td><span class="bar" style="width:${Math.max(2, Math.round((n / peak) * 100))}%"></span></td></tr>`
    }).join('')}</table></div>`)
  }

  // Categories
  const SELF = 'https://github.com/dsh-market/dsh-market' // as on the landing page: not ranked on our own site
  const RECENT_DAYS = 30
  const cutoff = date ? new Date(Date.parse(date) - RECENT_DAYS * 86400000).toISOString().slice(0, 10) : ''
  const cats = Object.keys(registry.categories ?? {}).map((id) => {
    const items = plugins.filter((p) => p.category === id)
    const top = items.filter((p) => p.downloads > 0 && p.url !== SELF).sort((a, b) => b.downloads - a.downloads)[0]
    const recent = cutoff ? items.filter((p) => String(p.added ?? '') > cutoff).length : 0
    return { id, items, recent, top }
  }).filter((c) => c.items.length).sort((a, b) => b.items.length - a.items.length)
  out.push(`<h2>${esc(t.catH)}</h2><p>${esc(t.catP(RECENT_DAYS))}</p>`)
  out.push(`<div class="tablewrap"><table><tr><th>${esc(t.cat)}</th><th class="n">${esc(t.plugins)}</th><th class="n">${esc(t.share)}</th><th class="n">${esc(t.recent)}</th><th>${esc(t.top)}</th></tr>${cats.map((c) => `<tr><td>${categoryPath && c.items.length >= MIN_PER_CATEGORY ? `<a href="${esc(categoryPath(loc, c.id))}">${esc(catName(c.id, loc))}</a>` : esc(catName(c.id, loc))}</td><td class="n">${fmt(c.items.length)}</td><td class="n">${pct(c.items.length, plugins.length)}%</td><td class="n">${fmt(c.recent)}</td><td>${c.top ? `<a href="${esc(pluginPath(loc, c.top.slug))}">${esc(c.top.displayName)}</a>` : '—'}</td></tr>`).join('')}</table></div>`)

  // Concentration
  const dls = plugins.map((p) => p.downloads).filter((d) => typeof d === 'number' && d > 0).sort((a, b) => b - a)
  if (dls.length >= 100) {
    const total = dls.reduce((a, b) => a + b, 0)
    const sum = (k) => dls.slice(0, k).reduce((a, b) => a + b, 0)
    const win = plugins.find((p) => p.downloadsEnd)?.downloadsEnd ?? date
    const asc = [...dls].sort((a, b) => a - b)
    const p90 = asc[Math.floor(asc.length * 0.9)]
    const npm = plugins.filter((p) => p.npm).length
    out.push(`<h2>${esc(t.concH)}</h2><p>${esc(t.concP(win, fmt(dls.length), fmt(plugins.length)))}</p><ul>`
      + `<li>${t.concTop10(pct(sum(10), total))}</li><li>${t.concTop100(pct(sum(100), total))}</li>`
      + `<li>${t.concMedian(fmt(median(dls)), fmt(p90))}</li>`
      + `<li>${t.concNone(fmt(plugins.length - dls.length), fmt(plugins.length))}</li>`
      + `<li>${t.npmShare(fmt(npm), pct(npm, plugins.length))}</li></ul>`)
  }

  // Capabilities
  const scanned = plugins.filter((p) => Array.isArray(p.capabilities))
  if (scanned.length >= 100) {
    const dates = scanned.map((p) => String(p.capabilityCheckedAt ?? '').slice(0, 10)).filter(Boolean).sort()
    const counts = Object.keys(t.capNames).map((k) => [k, scanned.filter((p) => p.capabilities.includes(k)).length]).sort((a, b) => b[1] - a[1])
    const none = scanned.filter((p) => p.capabilities.length === 0).length
    const both = scanned.filter((p) => p.capabilities.includes('network') && p.capabilities.includes('credentials')).length
    const install = scanned.filter((p) => (p.capabilityRedLines ?? []).some((r) => typeof r === 'string' && /postinstall|install time|at install/i.test(r))).length
    out.push(`<h2>${esc(t.capH)}</h2><p>${esc(t.capP(fmt(scanned.length), fmt(plugins.length), dates.at(-1) ?? ''))}</p>`)
    out.push(`<div class="tablewrap"><table><tr><th>${esc(t.capLabel)}</th><th class="n">${esc(t.capCount)}</th><th class="n">${esc(t.capPct)}</th></tr>${counts.map(([k, n]) => `<tr><td>${esc(t.capNames[k])}</td><td class="n">${fmt(n)}</td><td class="n">${pct(n, scanned.length)}%</td></tr>`).join('')}</table></div>`)
    out.push(`<ul><li>${t.capNone(fmt(none), pct(none, scanned.length))}</li><li>${t.capKeys(fmt(both), pct(both, scanned.length))}</li>${install > 0 ? `<li>${t.capInstall(fmt(install))}</li>` : ''}</ul>`)
    out.push(`<div class="callout"><p>${t.capNote}</p></div>`)
  }

  out.push(`<h2>${esc(t.methodH)}</h2><p>${t.methodP(`<a href="${esc(catalog)}">${esc(catalog.replace('https://', ''))}</a>`)}</p>`)
  return out.join('\n')
}
