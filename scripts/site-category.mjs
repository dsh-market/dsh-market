/**
 * One page per catalog category, computed from the snapshot and, where we have
 * it, from the real install tests (site/install-tests.json). Like the report,
 * nothing here is typed in: the numbers, the ranking and the test outcomes all
 * come from data, so the pages cannot drift from it.
 */
import { TESTED_UI } from './site-tested.mjs'

const fmt = (n) => new Intl.NumberFormat('en-US').format(n)
const pct = (a, b) => (b === 0 ? '0' : (Math.round((a / b) * 1000) / 10).toFixed(1))
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return 0
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}
export const MIN_PER_CATEGORY = 8
const TOP = 15
const RECENT = 10

export const CAT_UI = {
  en: {
    title: (c) => `${c} plugins for DSH: the most downloaded, newest, and what they do — dsh-market`,
    desc: (c, n) => `${n} DSH plugins in "${c}": the most downloaded, the newest additions, what they ask to do, and which ones we installed on a real host.`,
    h1: (c) => `${c}: DSH plugins`,
    lede: (c, n, date) => `${n} plugins in the "${c}" category, as of ${date}. Ranked by data, not by opinion.`,
    statsH: 'This category in numbers',
    stat: {
      share: (k, pctv) => `<b>${k}</b> entries, ${pctv}% of the catalog.`,
      recent: (k) => `<b>${k}</b> were added in the last 30 days.`,
      median: (m, k) => `The median plugin here has <b>${m}</b> downloads over 30 days (${k} publish a count). Counts include automated traffic, so read them as relative size.`,
      none: (k, pctv) => `<b>${k}</b> scanned plugins (${pctv}%) showed no file, network, command or key use in a static scan. Not detected is not the same as safe.`,
      keys: (k, pctv) => `<b>${k}</b> (${pctv}% of scanned) both use the network and read keys, which is normal for anything that calls a model.`,
    },
    topH: 'Most downloaded',
    topP: 'Downloads over the last 30 days from npm. Plugins that are not on npm have no count and are not ranked here.',
    newH: 'Newest in the catalog',
    newP: '"Added" is the day an entry joined the catalog, not the day the plugin was written.',
    cols: { plugin: 'Plugin', dl: 'Downloads', does: 'What the code does', test: 'Install test', added: 'Added' },
    noneScanned: 'not scanned yet',
    noneDetected: 'nothing detected',
    testedNote: (host, date) => `"Install test" is the result of installing the plugin on a clean DSH ${host} on ${date}; a dash means we have not tested it yet. <a href="__TESTED__">How we test</a>.`,
    more: 'Every plugin in this category is in the market itself. Open the market to search and install.',
    guides: 'Related reading',
  },
  zh: {
    title: (c) => `DSH「${c}」类插件：下载最多、最新收录、各自会做什么 — dsh-market`,
    desc: (c, n) => `DSH「${c}」分类下的 ${n} 个插件：下载最多的、最新收录的、会要求做什么，以及我们在真实宿主上装过的结果。`,
    h1: (c) => `${c}：DSH 插件`,
    lede: (c, n, date) => `截至 ${date}，「${c}」分类下有 ${n} 个插件。按数据排序，不按个人喜好。`,
    statsH: '这个分类的数字',
    stat: {
      share: (k, pctv) => `共 <b>${k}</b> 个条目，占目录的 ${pctv}%。`,
      recent: (k) => `近 30 天新增 <b>${k}</b> 个。`,
      median: (m, k) => `这里的中位数插件近 30 天有 <b>${m}</b> 次下载（${k} 个公布了数字）。数字含自动流量，请当作相对大小来看。`,
      none: (k, pctv) => `已扫描的插件里有 <b>${k}</b> 个（${pctv}%）在静态扫描中没发现读写文件、联网、运行命令或用密钥。没发现不等于安全。`,
      keys: (k, pctv) => `<b>${k}</b> 个（占已扫描的 ${pctv}%）既联网又读密钥，调用模型的插件都是这样，属于正常情况。`,
    },
    topH: '下载最多的',
    topP: '数字是 npm 近 30 天的下载量。没发布到 npm 的插件没有数字，不在这里排名。',
    newH: '最新收录的',
    newP: '「收录」指条目进入目录的那一天，不是插件写成的那一天。',
    cols: { plugin: '插件', dl: '下载量', does: '代码会做什么', test: '安装实测', added: '收录日期' },
    noneScanned: '还没扫描',
    noneDetected: '没发现',
    testedNote: (host, date) => `「安装实测」是 ${date} 在干净的 DSH ${host} 上安装这个插件的结果；横线表示我们还没测。<a href="__TESTED__">我们怎么测的</a>。`,
    more: '这个分类下的全部插件都在市场里，打开市场就能搜索和安装。',
    guides: '相关阅读',
  },
}

export function categoryBody(loc, { id, plugins, registry, catName, esc, pluginPath, tested, capNames }) {
  const t = CAT_UI[loc.code]
  const name = catName(id, loc)
  const date = registry.updated ?? ''
  const items = plugins.filter((p) => p.category === id)
  const out = []
  out.push(`<h1>${esc(t.h1(name))}</h1><p class="lede">${esc(t.lede(name, fmt(items.length), date))}</p>`)

  const cutoff = date ? new Date(Date.parse(date) - 30 * 86400000).toISOString().slice(0, 10) : ''
  const recent = cutoff ? items.filter((p) => String(p.added ?? '') >= cutoff).length : 0
  const dls = items.map((p) => p.downloads).filter((d) => typeof d === 'number' && d > 0)
  const scanned = items.filter((p) => Array.isArray(p.capabilities))
  const none = scanned.filter((p) => p.capabilities.length === 0).length
  const keys = scanned.filter((p) => p.capabilities.includes('network') && p.capabilities.includes('credentials')).length
  const lis = [t.stat.share(fmt(items.length), pct(items.length, plugins.length)), t.stat.recent(fmt(recent))]
  if (dls.length) lis.push(t.stat.median(fmt(median(dls)), fmt(dls.length)))
  if (scanned.length) lis.push(t.stat.none(fmt(none), pct(none, scanned.length)), t.stat.keys(fmt(keys), pct(keys, scanned.length)))
  out.push(`<h2>${esc(t.statsH)}</h2><ul>${lis.map((s) => `<li>${s}</li>`).join('')}</ul>`)

  const results = new Map()
  let host = null
  if (tested) {
    host = Object.keys(tested.hosts).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))[0]
    for (const r of tested.hosts[host]) results.set(r.npm, r)
  }
  const tu = TESTED_UI[loc.code]
  const testCell = (p) => {
    const r = p.npm ? results.get(p.npm) : undefined
    if (!r) return '—'
    return esc(typeof tu.kinds[r.kind] === 'function' ? tu.kinds[r.kind](String(r.requires ?? '?').replace(/^[\^>=~\s]+/, '').replace(/\s.*$/, '')) : (tu.kinds[r.kind] ?? tu.kinds.failed))
  }
  const doesCell = (p) => !Array.isArray(p.capabilities) ? esc(t.noneScanned)
    : p.capabilities.length === 0 ? esc(t.noneDetected)
      : p.capabilities.map((k) => esc(capNames[k] ?? k)).join(loc.code === 'zh' ? '、' : ', ')
  const link = (p) => `<a href="${esc(pluginPath(loc, p.slug))}">${esc(p.displayName)}</a>`

  const top = items.filter((p) => typeof p.downloads === 'number' && p.downloads > 0).sort((a, b) => b.downloads - a.downloads).slice(0, TOP)
  if (top.length) {
    out.push(`<h2>${esc(t.topH)}</h2><p>${esc(t.topP)}</p><div class="tablewrap"><table><tr><th>${esc(t.cols.plugin)}</th><th class="n">${esc(t.cols.dl)}</th><th>${esc(t.cols.does)}</th><th>${esc(t.cols.test)}</th></tr>${top.map((p) => `<tr><td>${link(p)}</td><td class="n">${fmt(p.downloads)}</td><td>${doesCell(p)}</td><td>${testCell(p)}</td></tr>`).join('')}</table></div>`)
    if (tested) out.push(`<p><small>${t.testedNote(esc(host), esc(tested.testedAt))}</small></p>`)
  }
  const fresh = [...items].filter((p) => p.added).sort((a, b) => String(b.added).localeCompare(String(a.added)) || a.displayName.localeCompare(b.displayName)).slice(0, RECENT)
  if (fresh.length) {
    out.push(`<h2>${esc(t.newH)}</h2><p>${esc(t.newP)}</p><div class="tablewrap"><table><tr><th>${esc(t.cols.plugin)}</th><th>${esc(t.cols.added)}</th><th>${esc(t.cols.does)}</th></tr>${fresh.map((p) => `<tr><td>${link(p)}</td><td>${esc(String(p.added))}</td><td>${doesCell(p)}</td></tr>`).join('')}</table></div>`)
  }
  out.push(`<p>${esc(t.more)}</p><h2>${esc(t.guides)}</h2><ul><li><a href="__GUIDE_permission-labels__">${esc(loc.code === 'zh' ? '插件页上的权限标签是什么意思' : 'What the permission labels mean')}</a></li><li><a href="__GUIDE_plugin-states__">${esc(loc.code === 'zh' ? '「已安装，未生效」是什么意思' : 'What each plugin state means')}</a></li><li><a href="__REPORT__">${esc(loc.code === 'zh' ? 'DSH 插件生态数据报告' : 'The DSH plugin ecosystem in numbers')}</a></li></ul>`)
  return out.join('\n')
}
