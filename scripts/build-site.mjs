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
import LOCALES from '../site/locales.mjs'

const ORIGIN = 'https://dshmarket.com'
const CATALOG = 'https://awesome-dsh-plugin.com'
const REGISTRY_FILE = 'data/registry-snapshot.json'
const OUT = 'docs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ldSafe = (s) => s.replaceAll('<', '\\u003c')

if (!fs.existsSync(REGISTRY_FILE)) {
  console.error(`${REGISTRY_FILE} is missing — run \`npm run snapshot\` first`)
  process.exit(1)
}
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
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

// A plugin's screenshots come from the catalog, and an <img> is a request the
// visitor's browser makes to a host we do not control. Same allowlist the
// catalog site uses: GitHub's own hosting, which these pages already rely on.
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

// Plugin pages live on the catalog site; every link from this site goes there.
const pluginPath = (loc, slug) => `${CATALOG}${loc.urlPath}p/${slug}/`

// ── landing-page catalog ────────────────────────────────────────────────────
// The front door used to be a 1.4 KB marketing page while /browse/ carried the
// whole index; 83% of visits landed on the thin one. This puts a real slice of
// the catalog on it — categories, what people actually install, what shipped
// recently — and leaves /browse/ as the complete flat index it already is.
//
// Only a slice: rendering all 1,700 entries here would just be a second copy
// of /browse/ at half a megabyte.
const POPULAR_N = 48
const SHOTS_N = 12
const FRESH_N = 24
// Our own listing tops the download chart. Ranking ourselves first on our own
// site reads as self-promotion rather than data, so it sits out both grids.
const SELF_URL = 'https://github.com/dsh-market/dsh-market'

const num = (n) => new Intl.NumberFormat('en-US').format(n)
const descOf = (p, loc) => esc(p.description?.[loc.code] ?? p.description?.en ?? '')

const metaRow = (p, loc) => {
  const bits = []
  if (p.stars) bits.push(`<span>★ ${num(p.stars)}</span>`)
  if (p.downloads) bits.push(`<span>${num(p.downloads)}${esc(loc.strings.HOME_WEEK)}</span>`)
  bits.push(`<span class="pc">${esc(catName(p.category, loc))}</span>`)
  return `<div class="pmeta">${bits.join('')}</div>`
}

const textCard = (p, loc) =>
  `    <li class="pcard"><a class="pname" href="${pluginPath(loc, p.slug)}"><span class="owner">${esc(p.owner)}/</span>${esc(p.name)}</a><p>${descOf(p, loc)}</p>${metaRow(p, loc)}</li>`

// Screenshots are third-party URLs from the catalog, so they go through the
// same allowlist the README images do. aspect-ratio reserves the box before
// the image lands, which is why these cards carry no width/height: the source
// dimensions are unknown and vary per plugin.
const shotCard = (p, loc) => {
  const src = (p.screenshots ?? []).find(imgAllowed)
  return `    <li class="scard"><a href="${pluginPath(loc, p.slug)}"><span class="shot"><img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span><span class="pname"><span class="owner">${esc(p.owner)}/</span>${esc(p.name)}</span></a><p>${descOf(p, loc)}</p>${metaRow(p, loc)}</li>`
}

const homeSection = (id, title, lead, cls, cards) => `<section class="hs" id="${id}">
  <h2>${esc(title)}</h2>
  <p class="lead">${esc(lead)}</p>
  <ul class="${cls}">
${cards.join('\n')}
  </ul>
</section>`

function homeCatalog(loc) {
  const s = loc.strings
  const counts = CATS
    .map((id) => ({ id, name: catName(id, loc), n: plugins.filter((p) => p.category === id).length }))
    .filter((c) => c.n)

  const popular = plugins
    .filter((p) => p.downloads && p.url !== SELF_URL)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, POPULAR_N)
  const shots = plugins
    .filter((p) => p.url !== SELF_URL && (p.screenshots ?? []).some(imgAllowed))
    .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    .slice(0, SHOTS_N)
  const fresh = [...plugins]
    .sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? '')))
    .slice(0, FRESH_N)

  const out = [
    `<nav class="cats" aria-label="${esc(s.HOME_CATS)}">${counts
      .map((c) => `<a href="${loc.browsePath}#${c.id}">${esc(c.name)}<small>${c.n}</small></a>`)
      .join('')}</nav>`,
  ]
  // Every section is conditional on having rows. `downloads` and `screenshots`
  // are newer catalog fields, and a snapshot that predates either one (or a
  // catalog that stops publishing them) should drop the section rather than
  // render a heading over an empty list.
  if (popular.length) out.push(homeSection('popular', s.HOME_POPULAR, s.HOME_POPULAR_LEAD, 'cards', popular.map((p) => textCard(p, loc))))
  // A gallery only looks like one when every card has an image; 228 of 1,733
  // plugins ship screenshots, so this is its own section rather than a ragged
  // mix inside the grid above.
  if (shots.length) out.push(homeSection('shots', s.HOME_SHOTS, s.HOME_SHOTS_LEAD, 'shots', shots.map((p) => shotCard(p, loc))))
  if (fresh.length) out.push(homeSection('fresh', s.HOME_NEW, s.HOME_NEW_LEAD, 'cards', fresh.map((p) => textCard(p, loc))))
  out.push(`<p class="allmore"><a href="${loc.browsePath}">${esc(s.HOME_ALL.replace('{N}', num(plugins.length)))}</a></p>`)
  return out.join('\n')
}

const homeCss = () => `<style>
/* The base sheet only clears underlines on header/footer links, so every new
   link here has to opt out explicitly. */
.cats a,.pcard a,.scard a,.allmore a{text-decoration:none;color:inherit}
.cats{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 0}
.cats a{display:inline-flex;align-items:baseline;gap:.35rem;font-size:.82rem;color:var(--ink2);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.3rem .8rem}
.cats a:hover{border-color:var(--accent);color:var(--accent)}
.cats small{color:var(--ink3);font-size:.72rem}
.hs{margin-top:2.4rem}
.hs h2{font-size:1.15rem;margin:0}
.hs .lead{color:var(--ink2);font-size:.88rem;margin:.25rem 0 1rem}
ul.cards,ul.shots{list-style:none;padding:0;margin:0;display:grid;gap:.85rem}
ul.cards{grid-template-columns:repeat(auto-fill,minmax(17rem,1fr))}
ul.shots{grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))}
.pcard,.scard{background:var(--card);border:1px solid var(--line);border-radius:10px}
.pcard{padding:.85rem .95rem}
.scard{overflow:hidden}
.pname{font-weight:650;font-size:.92rem}
.pcard a.pname:hover,.scard a:hover .pname{color:var(--accent)}
.owner{color:var(--ink3);font-weight:400}
.pcard p,.scard p{color:var(--ink2);font-size:.84rem;line-height:1.45}
.pcard p{margin:.35rem 0 .5rem}
.scard .shot{display:block;aspect-ratio:16/9;background:var(--bg);overflow:hidden}
.scard .shot img{width:100%;height:100%;object-fit:cover;display:block}
.scard .pname{display:block;padding:.7rem .95rem 0}
.scard p{margin:.3rem 0 .5rem;padding:0 .95rem}
.pmeta{display:flex;flex-wrap:wrap;gap:.5rem;font-size:.75rem;color:var(--ink3)}
.scard .pmeta{padding:0 .95rem .85rem}
.pmeta .pc{color:var(--accent)}
.allmore{margin-top:1.6rem;font-weight:600}
.allmore a{color:var(--accent)}
</style>`

// ── landing + privacy pages (hand-written, copied with the count synced) ────
for (const loc of LOCALES) {
  for (const [src, urlPath] of [[loc.index, loc.urlPath], [loc.privacy, loc.privacyPath]]) {
    if (!fs.existsSync(src)) { console.error(`${src} is missing`); process.exit(1) }
    // The privacy page carries no catalog and no ad — it is the page that
    // describes what the other pages load, so it stays plain. Resolving the
    // tokens to '' there (rather than leaving them unhandled) means a token
    // pasted into it by mistake renders as nothing instead of an ad.
    const landing = src === loc.index
    let page = fs.readFileSync(src, 'utf8')
      .replaceAll('__COUNT__', () => String(plugins.length))
      .replaceAll('__BROWSE__', () => loc.browsePath)
      .replaceAll('__HOME_CSS__', () => (landing ? homeCss() : ''))
      .replaceAll('__HOME_CATALOG__', () => (landing ? homeCatalog(loc) : ''))
    page = applyStrings(page, loc)
    if (urlPath === '/') fs.writeFileSync(`${OUT}/index.html`, page)
    else write(urlPath, page)
  }
}

// ── install page ────────────────────────────────────────────────────────────
// Instructions, not a second catalog: the plugin pages carry each plugin, and
// this page answers the one question they cannot — what to do with the command
// they show, and what the four common failures mean. The body is per-locale
// HTML, the way index and privacy are.
for (const loc of LOCALES) {
  if (!fs.existsSync(loc.install)) { console.error(`${loc.install} is missing`); process.exit(1) }
  const url = ORIGIN + loc.installPath
  let page = fs.readFileSync(loc.install, 'utf8')
    .replaceAll('__URL__', () => url)
    .replaceAll('__HREFLANGS__', () => hreflangs((l) => l.installPath))
    .replaceAll('__BROWSE__', () => loc.browsePath)
    .replaceAll('__HOME__', () => loc.urlPath)
    .replaceAll('__PRIVACY__', () => loc.privacyPath)
    .replaceAll('__LOCALE_LINKS__', () => localeLinks(loc, (l) => l.installPath))
  write(loc.installPath, applyStrings(page, loc))
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
${c.items.map((p) => `    <li><a href="${pluginPath(loc, p.slug)}"><span class="owner">${esc(p.owner)}/</span>${esc(p.name)}</a></li>`).join('\n')}
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
    .replaceAll('__INSTALL__', () => loc.installPath)
    .replaceAll('__PRIVACY__', () => loc.privacyPath)
    .replaceAll('__LOCALE_LINKS__', () => localeLinks(loc, (l) => l.browsePath))
    .replaceAll('__JUMP__', () => jump)
    .replaceAll('__SECTIONS__', () => sections)
  write(loc.browsePath, applyStrings(page, loc))
}

// ── plugin redirects ────────────────────────────────────────────────────────
// This site used to render its own copy of every plugin page: the same catalog
// content as awesome-dsh-plugin.com, canonicalised to it. The result was 2,954
// URLs parked as "alternate page with proper canonical" and 212 MB of
// duplicated third-party text in the deploy — the profile of a mirror, not of
// a market. The list owns the plugin pages; this site sends people there and
// keeps the old /p/ URLs working, because posts and issues link to them.
const redirectMaster = fs.readFileSync('site/plugin-redirect.html', 'utf8')
for (const loc of LOCALES) {
  for (const p of plugins) {
    const target = pluginPath(loc, p.slug)
    const page = redirectMaster
      .replaceAll('__LANG__', () => loc.htmlLang)
      .replaceAll('__TITLE__', () => esc(`${p.displayName} — ${loc.strings.REDIRECT_TITLE}`))
      .replaceAll('__TARGET__', () => esc(target))
      .replaceAll('__TARGET_JS__', () => ldSafe(JSON.stringify(target)))
      .replaceAll('__LEAD__', () => esc(loc.strings.REDIRECT_LEAD))
    write(`${loc.urlPath}p/${p.slug}/`, page)
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

// Plugin URLs are absent on purpose. They are redirect stubs to the catalog
// and carry noindex, so a sitemap — a list of URLs a site claims as its own —
// has no business naming them. /browse/ links straight to the catalog pages.
const updated = registry.updated ?? new Date().toISOString().slice(0, 10)
fs.writeFileSync(`${OUT}/sitemap.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntry((l) => l.urlPath, updated, 'weekly')}
${urlEntry((l) => l.browsePath, updated, 'daily')}
${urlEntry((l) => l.installPath, updated, 'monthly')}
${urlEntry((l) => l.privacyPath, updated, 'yearly')}
</urlset>
`)

// The plugin market index, mirrored so dshmarket.com answers the same URL as
// the list it comes from. One source of truth: the document is generated and
// validated upstream (awesome-dsh-plugin.com/index.json) and copied here at
// build time — this site never derives a second one. A deploy without it (the
// fetch failed, or the upstream was mid-rebuild) still ships the pages; it
// just does not claim an index it does not have.
const INDEX_FILE = 'data/market-index.json'
let indexMirrored = false
if (fs.existsSync(INDEX_FILE)) {
  try {
    // Written back verbatim, not re-serialized: the document is fetched by a
    // host whose fetch budget is fixed (15 s), and upstream already ships it
    // minified for that reason. Pretty-printing here added 20% to the wire.
    const raw = fs.readFileSync(INDEX_FILE, 'utf8')
    const mirrored = JSON.parse(raw)
    if (mirrored?.format === 1 && Array.isArray(mirrored.plugins) && mirrored.plugins.length > 0) {
      fs.writeFileSync(`${OUT}/index.json`, raw.endsWith('\n') ? raw : `${raw}\n`)
      indexMirrored = true
      console.log(`index mirrored: ${mirrored.plugins.length} plugins`)
    } else {
      console.log('index not mirrored: upstream document is empty or not format 1')
    }
  } catch (error) {
    console.log(`index not mirrored: ${error instanceof Error ? error.message : String(error)}`)
  }
} else {
  console.log('index not mirrored: data/market-index.json was not fetched')
}

// Real pages only: the stubs are redirects, not content, and counting them as
// pages is how the deploy looked four times larger than it is.
const pages = LOCALES.length * 4 // index, browse, install, privacy
console.log(`site built: ${pages} pages, ${plugins.length} redirect stubs × ${LOCALES.length} locales`)
