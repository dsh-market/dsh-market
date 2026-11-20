/**
 * Anonymous daily count for dsh-market (see SECURITY.md, "Anonymous usage
 * count"). Each install posts at most once per UTC day; the row holds only a
 * random install id, the market and DSH versions, desktop or web, and the
 * region. No IP address or header is stored. Rows older than 400 days are
 * deleted by the daily cron.
 */
const ID = /^[0-9a-f]{32}$/
const VERSION = /^[0-9A-Za-z.+_-]{1,40}$/
const KINDS = new Set(['desktop', 'web'])
const REGION = /^[a-z]{2,10}$/

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/v1/ping') return new Response('not found', { status: 404 })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const text = await request.text()
    if (text.length > 1024) return new Response(null, { status: 413 })
    let body
    try { body = JSON.parse(text) } catch { return new Response(null, { status: 400 }) }
    const { id, v, hv, kind, region } = body ?? {}
    if (!ID.test(id ?? '') || !VERSION.test(v ?? '') || !(hv === null || VERSION.test(hv ?? ''))
      || !KINDS.has(kind) || !REGION.test(region ?? '')) {
      return new Response(null, { status: 400 })
    }
    const day = new Date().toISOString().slice(0, 10)
    await env.DB.prepare('INSERT OR IGNORE INTO pings (day, id, v, hv, kind, region) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(day, id, v, hv, kind, region).run()
    return new Response(null, { status: 204 })
  },

  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM pings WHERE day < date('now', '-400 days')").run()
  },
}
