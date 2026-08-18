#!/usr/bin/env node
/**
 * Build dshmarket.com from the published catalog.
 *
 * Data comes from awesome-dsh-plugin, which is the list's home and stays that
 * way: `data/registry-snapshot.json` is its /plugins.json, and
 * `data/readmes-snapshot.json` is its /readmes.json. Both are refreshed by
 * `npm run snapshot`. Nothing here re-probes GitHub — one probe, one copy of
 * the truth, no drift between the two sites.
 *
 * Output is docs/, which is generated in full and git-ignored: a from-scratch
 * build on an empty docs/ produces the complete site.
 *
 * Usage: node scripts/build-site.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { Marked } from 'marked'
import LOCALES from '../site/locales.mjs'

const ORIGIN = 'https://dshmarket.com'
const CATALOG = 'https://awesome-dsh-plugin.com'
const REGISTRY_FILE = 'data/registry-snapshot.json'
const READMES_FILE = 'data/readmes-snapshot.json'
const OUT = 'docs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ldSafe = (s) => s.replaceAll('<', '\\u003c')

if (!fs.existsSync(REGISTRY_FILE)) {
  console.error(`${REGISTRY_FILE} is missing — run \`npm run snapshot\` first`)
  process.exit(1)
}
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
// Optional: without it, pages still build, they just carry no README body.
// Missing is a warning rather than an error so a catalog outage degrades the
// pages instead of failing the deploy that would have refreshed them.
const readmes = fs.existsSync(READMES_FILE)
  ? JSON.parse(fs.readFileSync(READMES_FILE, 'utf8')).readmes ?? {}
  : (console.warn(`${READMES_FILE} is missing — building without README bodies`), {})

const plugins = registry.plugins ?? []
if (!plugins.length) {
  console.error(`${REGISTRY_FILE} lists no plugins — refusing to build an empty site`)
  process.exit(1)
}
// Category order and names come from the registry too, so a category added
// upstream appears here without a code change on this side.
const CATS = Object.keys(registry.categories ?? {})
const catName = (id, loc) => registry.categories?.[id]?.[loc.code] ?? id

// Slug matches awesome-dsh-plugin's, derived from the same repo path. Keeping
// them identical means /p/<slug>/ on either host is the same plugin — which is
// what makes a cross-domain canonical (or, later, a redirect) a pure host swap
// with nothing to map.
function slugOf(p) {
  const repoPath = p.url.replace('https://github.com/', '')
  const repo = repoPath.split('/').slice(0, 2).join('/')
  const sub = repoPath.includes('/tree/') ? repoPath.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  return sub ? `${repo}--${sub.replaceAll('/', '-')}` : repo
}
for (const p of plugins) {
  p.slug = slugOf(p)
  p.displayName = p.owner ? `${p.owner}/${p.name}` : p.name
}

fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync('site/assets')) {
  fs.mkdirSync(`${OUT}/assets`, { recursive: true })
  fs.copyFileSync(`site/assets/${f}`, `${OUT}/assets/${f}`)
}
for (const f of ['CNAME', 'robots.txt']) fs.copyFileSync(`site/${f}`, `${OUT}/${f}`)

// ── README rendering ────────────────────────────────────────────────────────
// Same image policy as the catalog site, for the same reason: a README is
// third-party markdown, and an <img> in it is a request the visitor's browser
// makes to a host we do not control. Restricted to GitHub's own hosting, which
// adds nobody new — these pages are served from GitHub Pages already.
const IMG_HOSTS = new Set([
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
])
const imgAllowed = (href) => {
  if (/^data:/i.test(href)) return true
  try { return IMG_HOSTS.has(new URL(href).hostname) } catch { return false }
}
function renderReadme(rm) {
  const abs = (href, base, allowData = false) => {
    if (!href || /^(https?:|mailto:|#)/i.test(href)) return href
    if (/^data:/i.test(href)) return allowData ? href : '#'
    return base + href.replace(/^\.\//, '').replace(/^\//, '')
  }
  const md = new Marked({
    walkTokens(t) {
      if (t.type === 'heading') t.depth = Math.min(t.depth + 1, 6)
      else if (t.type === 'image') t.href = abs(t.href, rm.base, true)
      else if (t.type === 'link') t.href = abs(t.href, rm.blobBase)
    },
    renderer: {
      html: () => '',
      image({ href, title, text }) {
        if (!href || !imgAllowed(href)) return ''
        const t = title ? ` title="${esc(title)}"` : ''
        return `<img src="${esc(href)}" alt="${esc(text ?? '')}"${t} loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      },
    },
  })
  try {
    let html = md.parse(rm.md.replace(/^\s*# .*\n/, ''))
    // Dropping an image can empty the link that wrapped it and then the
    // paragraph that held the link; loop until nothing more collapses.
    for (let prev = null; prev !== html;) {
      prev = html
      html = html.replace(/<a\b[^>]*>\s*<\/a>/g, '').replace(/<p>\s*<\/p>\s*/g, '')
    }
    return html
  } catch {
    return null
  }
}

// ── shared page furniture ───────────────────────────────────────────────────
const applyStrings = (page, loc) => {
  for (const [k, v] of Object.entries(loc.strings)) page = page.replaceAll(`__T_${k}__`, () => v)
  return page
}
const localeLinks = (loc, pathFor) => LOCALES.filter((l) => l.code !== loc.code)
  .map((l) => `<a href="${pathFor(l)}" hreflang="${l.code}" rel="alternate">${l.label}</a>`).join('\n  ')
const hreflangs = (pathFor) => [
  ...LOCALES.map((l) => `<link rel="alternate" hreflang="${l.code}" href="${ORIGIN}${pathFor(l)}">`),
  `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${pathFor(LOCALES[0])}">`,
].join('\n')
const write = (urlPath, html) => {
  const dir = path.join(OUT, urlPath.replace(/^\//, '').replace(/\/$/, ''))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), html)
}

const pluginPath = (loc, slug) => `${loc.urlPath}p/${slug}/`

// ── landing + privacy pages (hand-written, copied with the count synced) ────
for (const loc of LOCALES) {
  for (const [src, urlPath] of [[loc.index, loc.urlPath], [loc.privacy, loc.privacyPath]]) {
    if (!fs.existsSync(src)) { console.error(`${src} is missing`); process.exit(1) }
    let page = fs.readFileSync(src, 'utf8')
      .replaceAll('__COUNT__', () => String(plugins.length))
      .replaceAll('__BROWSE__', () => loc.browsePath)
    page = applyStrings(page, loc)
    if (urlPath === '/') fs.writeFileSync(`${OUT}/index.html`, page)
    else write(urlPath, page)
  }
}

// ── browse index ────────────────────────────────────────────────────────────
for (const loc of LOCALES) {
  const byCat = CATS.map((id) => ({
    id,
    name: catName(id, loc),
    items: plugins.filter((p) => p.category === id).sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1)),
  })).filter((c) => c.items.length)

  const jump = byCat.map((c) => `<a href="#${c.id}">${esc(c.name)}<small>${c.items.length}</small></a>`).join('\n    ')
  const sections = byCat.map((c) => `<section class="cat" id="${c.id}">
  <h2>${esc(c.name)}<small>${c.items.length}</small></h2>
  <ul class="list">
${c.items.map((p) => `    <li><a href="${pluginPath(loc, p.slug)}"><span class="owner">${esc(p.owner)}/</span>${esc(p.name)}</a><p>${esc(p.description?.[loc.code] ?? p.description?.en ?? '')}</p></li>`).join('\n')}
  </ul>
</section>`).join('\n')

  let page = fs.readFileSync('site/browse-template.html', 'utf8')
    .replaceAll('__LANG__', () => loc.htmlLang)
    .replaceAll('__TITLE__', () => esc(loc.BROWSE_TITLE.replaceAll('{N}', plugins.length)))
    .replaceAll('__DESC__', () => esc(loc.BROWSE_DESC.replaceAll('{N}', plugins.length)))
    .replaceAll('__URL__', () => ORIGIN + loc.browsePath)
    .replaceAll('__HREFLANGS__', () => hreflangs((l) => l.browsePath))
    .replaceAll('__OG_IMAGE__', () => `${ORIGIN}/assets/demo-${loc.code}.png`)
    .replaceAll('__HOME__', () => loc.urlPath)
    .replaceAll('__PRIVACY__', () => loc.privacyPath)
    .replaceAll('__LOCALE_LINKS__', () => localeLinks(loc, (l) => l.browsePath))
    .replaceAll('__JUMP__', () => jump)
    .replaceAll('__SECTIONS__', () => sections)
  write(loc.browsePath, applyStrings(page, loc))
}

// ── plugin pages ────────────────────────────────────────────────────────────
const pluginMaster = fs.readFileSync('site/plugin-template.html', 'utf8')
let readmeCount = 0
let mismatchCount = 0
for (const loc of LOCALES) {
  for (const p of plugins) {
    const url = ORIGIN + pluginPath(loc, p.slug)
    const desc = p.description?.[loc.code] ?? p.description?.en ?? ''
    const metaDesc = desc.length > 155 ? desc.slice(0, 152).trimEnd() + '…' : desc

    const facts = [
      p.stars != null ? `<span>${loc.strings.P_STARS} <b>★ ${p.stars}</b></span>` : '',
      `<span>${loc.strings.P_CAT} <b>${esc(catName(p.category, loc))}</b></span>`,
      p.added ? `<span>${loc.strings.P_ADDED} <b>${esc(p.added)}</b></span>` : '',
      p.npm ? `<span>${loc.strings.P_NPM} <b>${esc(p.npm)}</b></span>` : '',
    ].filter(Boolean).join('\n    ')

    const cmd = (c, note) => `<p class="note">${note}</p>
      <div class="cmd"><pre>${esc(c)}</pre><button type="button" data-cmd="${esc(c)}" data-copied="${esc(loc.strings.COPIED)}">${esc(loc.strings.COPY)}</button></div>`
    const install = [
      cmd('dsh plugin --profile web add dshmarket', loc.strings.P_INSTALL_MARKET),
      cmd(p.install, loc.strings.P_INSTALL_CLI),
    ].join('\n      ')

    const shots = (p.screenshots ?? []).filter((s) => imgAllowed(s))
    const shotSection = shots.length ? `<section class="panel">
      <h2>${loc.strings.P_SHOTS}</h2>
      <div class="shots">
${shots.map((s) => `        <img src="${esc(s)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`).join('\n')}
      </div>
    </section>` : ''

    const links = [
      `<p><a href="${esc(p.url)}" rel="noopener">${loc.strings.P_GH}</a></p>`,
      p.npm ? `<p><a href="https://www.npmjs.com/package/${esc(p.npm)}" rel="noopener">${loc.strings.P_NPM_LINK}</a></p>` : '',
      `<p><a href="${CATALOG}${loc.urlPath}p/${p.slug}/" rel="noopener">${loc.strings.P_CATALOG}</a></p>`,
    ].filter(Boolean).join('\n      ')

    // Cut the sidebar blurbs at a word rather than mid-token: "cloudflared
    // tunne" reads as a broken page, not as a shortened sentence. CJK has no
    // spaces, so there the hard cut stands and an ellipsis carries the meaning.
    const blurb = (s, n = 90) => {
      if (s.length <= n) return s
      const head = s.slice(0, n)
      const sp = head.lastIndexOf(' ')
      return (sp > n * 0.6 ? head.slice(0, sp) : head).trimEnd() + '…'
    }
    const related = plugins
      .filter((r) => r.category === p.category && r.url !== p.url)
      .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
      .slice(0, 6)
    const relSection = related.length ? `<section class="panel">
      <h2>${loc.strings.P_RELATED}</h2>
      <ul class="rel">
${related.map((r) => `        <li><a href="${pluginPath(loc, r.slug)}">${esc(r.displayName)}</a><p>${esc(blurb(r.description?.[loc.code] ?? r.description?.en ?? ''))}</p></li>`).join('\n')}
      </ul>
    </section>` : ''

    // README: prefer this page's language, fall back to whatever exists, and
    // mark the block with its real lang when they differ. A page that claims
    // lang="en" around Chinese prose misinforms every consumer that reads it.
    const entry = readmes[p.url]
    let rm = null
    let rmLang = null
    if (entry) {
      for (const code of [loc.code, ...LOCALES.map((l) => l.code)]) {
        if (entry[code]) { rm = entry[code]; rmLang = code; break }
      }
    }
    const readmeHtml = rm ? renderReadme(rm) : null
    const mismatch = rm != null && rmLang !== loc.code
    if (readmeHtml) readmeCount++
    if (mismatch) mismatchCount++
    const rmLocale = LOCALES.find((l) => l.code === rmLang)
    const readmeSection = readmeHtml ? `<section class="panel">
      <h2>${loc.strings.P_README}</h2>${mismatch ? `\n      <p class="note">${esc(loc.strings.P_README_ONLY.replace('{LANG}', loc.langNames[rmLang] ?? rmLang))}</p>` : ''}
      <div class="md" lang="${rmLocale?.htmlLang ?? loc.htmlLang}">
${readmeHtml}
      </div>
      <p class="note"><a href="${esc(rm.htmlUrl)}" rel="noopener">${loc.strings.P_README_SRC}</a></p>
    </section>` : ''

    const jsonld = JSON.stringify([{
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: p.displayName,
      url,
      description: desc,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'DeepSeek Harness',
      offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
      sameAs: [p.url, p.npm ? `https://www.npmjs.com/package/${p.npm}` : null].filter(Boolean),
    }, {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: loc.strings.CRUMB_HOME, item: ORIGIN + loc.urlPath },
        { '@type': 'ListItem', position: 2, name: loc.strings.CRUMB_BROWSE, item: ORIGIN + loc.browsePath },
        { '@type': 'ListItem', position: 3, name: p.displayName, item: url },
      ],
    }])

    let page = pluginMaster
      .replaceAll('__P_README_SECTION__', () => readmeSection)
      .replaceAll('__LANG__', () => loc.htmlLang)
      .replaceAll('__TITLE__', () => esc(loc.P_TITLE.replace('{NAME}', p.displayName)))
      .replaceAll('__DESC__', () => esc(metaDesc))
      .replaceAll('__URL__', () => url)
      .replaceAll('__HREFLANGS__', () => hreflangs((l) => pluginPath(l, p.slug)))
      .replaceAll('__OG_IMAGE__', () => `${ORIGIN}/assets/demo-${loc.code}.png`)
      .replaceAll('__JSONLD__', () => ldSafe(jsonld))
      .replaceAll('__HOME__', () => loc.urlPath)
      .replaceAll('__BROWSE__', () => loc.browsePath)
      .replaceAll('__PRIVACY__', () => loc.privacyPath)
      .replaceAll('__LOCALE_LINKS__', () => localeLinks(loc, (l) => pluginPath(l, p.slug)))
      .replaceAll('__P_SHORT__', () => esc(p.name))
      .replaceAll('__P_H1__', () => `<span class="owner">${esc(p.owner)}/</span>${esc(p.name)}`)
      .replaceAll('__P_DESC__', () => esc(desc))
      .replaceAll('__P_FACTS__', () => facts)
      .replaceAll('__P_INSTALL__', () => install)
      .replaceAll('__P_SHOTS__', () => shotSection)
      .replaceAll('__P_LINKS__', () => links)
      .replaceAll('__P_RELATED__', () => relSection)
    write(pluginPath(loc, p.slug), applyStrings(page, loc))
  }
}

// ── sitemap ─────────────────────────────────────────────────────────────────
// lastmod is the date the underlying data last changed, not the date this file
// was written: a lastmod that moves nightly without the page changing teaches a
// crawler to stop believing every lastmod on the site.
const alt = (pathFor) => [
  ...LOCALES.map((l) => `      <xhtml:link rel="alternate" hreflang="${l.code}" href="${ORIGIN}${pathFor(l)}"/>`),
  `      <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${pathFor(LOCALES[0])}"/>`,
].join('\n')
const urlEntry = (pathFor, lastmod, freq) => LOCALES.map((l) => `  <url>
    <loc>${ORIGIN}${pathFor(l)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${freq}</changefreq>
${alt(pathFor)}
  </url>`).join('\n')

const updated = registry.updated ?? new Date().toISOString().slice(0, 10)
fs.writeFileSync(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntry((l) => l.urlPath, updated, 'weekly')}
${urlEntry((l) => l.browsePath, updated, 'daily')}
${plugins.map((p) => urlEntry((l) => pluginPath(l, p.slug), p.added ?? updated, 'weekly')).join('\n')}
${urlEntry((l) => l.privacyPath, updated, 'yearly')}
</urlset>
`)

const pages = plugins.length * LOCALES.length + LOCALES.length * 3
console.log(`site built: ${plugins.length} plugins × ${LOCALES.length} locales = ${pages} pages`)
console.log(`  README bodies rendered: ${readmeCount} (${mismatchCount} in a fallback language)`)
