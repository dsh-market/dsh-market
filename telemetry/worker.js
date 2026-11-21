/**
 * Anonymous daily count for dsh-market (see SECURITY.md, "Anonymous usage
 * count"). Each install posts at most once per UTC day; the row holds only a
 * random install id, the market and DSH versions, desktop or web, the region,
 * and whether the market page was opened that day (a second post, same row).
 * No IP address or header is stored. Rows older than 400 days are
 * deleted by the daily cron. The hourly cron also folds rows into the
 * aggregates behind the private dashboard (see rollup.js).
 */
import page from './stats.html'
import { cleanup, dashboard, runRollup } from './rollup.js'

const ID = /^[0-9a-f]{32}$/
const VERSION = /^[0-9A-Za-z.+_-]{1,40}$/
const KINDS = new Set(['desktop', 'web'])
const REGION = /^[a-z]{2,10}$/
const STATS_HOST = 'stats.dshmarket.com'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.hostname === STATS_HOST) return stats(request, env, ctx, url)
    if (url.pathname !== '/v1/ping') return new Response('not found', { status: 404 })
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const text = await request.text()
    if (text.length > 1024) return new Response(null, { status: 413 })
    let body
    try { body = JSON.parse(text) } catch { return new Response(null, { status: 400 }) }
    const { id, v, hv, kind, region, opened } = body ?? {}
    if (!ID.test(id ?? '') || !VERSION.test(v ?? '') || !(hv === null || VERSION.test(hv ?? ''))
      || !KINDS.has(kind) || !REGION.test(region ?? '') || !(opened === undefined || opened === true)) {
      return new Response(null, { status: 400 })
    }
    const day = new Date().toISOString().slice(0, 10)
    // First post of the day makes the row; a later one with opened:true only
    // flips that flag, and nothing ever flips it back.
    await env.DB.prepare(`INSERT INTO pings (day, id, v, hv, kind, region, opened) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, id) DO UPDATE SET opened = MAX(opened, excluded.opened)`)
      .bind(day, id, v, hv, kind, region, opened === true ? 1 : 0).run()
    return new Response(null, { status: 204 })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      await runRollup(env)
      if (new Date().getUTCHours() === 3) await cleanup(env)
    })())
  },
}

/**
 * Private dashboard on stats.dshmarket.com: the page itself, and the daily
 * aggregates it draws (counts only, never an install id). Sign-in is Google;
 * only ALLOWED_EMAIL gets in. The session is a signed 30-day cookie, so
 * rotating SESSION_SECRET signs everyone out.
 */
const COOKIE = 'dshm_stats'
const STATE_COOKIE = 'dshm_stats_state'
const SESSION_DAYS = 30
const REDIRECT = `https://${STATS_HOST}/auth/callback`
const headers = { 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' }

async function stats(request, env, ctx, url) {
  if (url.pathname === '/login') {
    const state = hex(crypto.getRandomValues(new Uint8Array(16)))
    const google = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    google.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code',
      scope: 'openid email', state, prompt: 'select_account', login_hint: env.ALLOWED_EMAIL }).toString()
    return new Response(null, { status: 302, headers: { ...headers, location: google.toString(),
      'set-cookie': `${STATE_COOKIE}=${state}; Path=/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax` } })
  }
  if (url.pathname === '/auth/callback') return callback(request, env, url)
  if (url.pathname === '/logout') {
    return new Response(null, { status: 302, headers: { ...headers, location: '/', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } })
  }
  if (!(await signedIn(request, env))) {
    if (url.pathname.startsWith('/api/')) return new Response('sign in first', { status: 401, headers })
    return html(loginPage(''), 401)
  }
  if (url.pathname === '/') return html(page, 200)
  if (url.pathname === '/api/rollup' && request.method === 'POST') {
    // Same as the hourly cron, on demand (signed-in only).
    await runRollup(env)
    await caches.default.delete(new Request(`https://${STATS_HOST}/__cache/dashboard`))
    return new Response(null, { status: 204, headers })
  }
  if (url.pathname !== '/api/dashboard') return new Response('not found', { status: 404, headers })

  // Finished days come from the rollup; only today is counted live, so one
  // copy for five minutes keeps reloads cheap.
  const cacheKey = new Request(`https://${STATS_HOST}/__cache/dashboard`)
  const cached = await caches.default.match(cacheKey)
  if (cached) return new Response(cached.body, { headers: { ...headers, 'content-type': 'application/json' } })
  const body = JSON.stringify(await dashboard(env))
  ctx.waitUntil(caches.default.put(cacheKey, new Response(body, { headers: { 'cache-control': 'max-age=300' } })))
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } })
}

async function callback(request, env, url) {
  const state = cookie(request, STATE_COOKIE)
  const code = url.searchParams.get('code')
  if (!state || !code || url.searchParams.get('state') !== state) return html(loginPage('登录过期了，请重新登录。'), 400)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT, grant_type: 'authorization_code' }),
  })
  if (!res.ok) return html(loginPage('Google 没有确认这次登录，请重试。'), 502)
  // The ID token came straight from Google over TLS, so its claims can be
  // read without checking the signature (Google's documented exception).
  const { id_token: idToken } = await res.json()
  let claims
  try { claims = JSON.parse(new TextDecoder().decode(b64url(idToken.split('.')[1]))) } catch { return html(loginPage('Google 返回的内容读不了，请重试。'), 502) }
  const issuerOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com'
  if (!issuerOk || claims.aud !== env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now()) return html(loginPage('登录没有通过校验，请重试。'), 403)
  if (!claims.email_verified || String(claims.email).toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
    return html(loginPage(`${escapeHtml(claims.email ?? '这个账号')} 没有权限查看。请换成管理员的 Google 账号。`), 403)
  }
  const exp = Date.now() + SESSION_DAYS * 86400e3
  const value = `${exp}.${await sign(env, `${exp}.${claims.email}`)}`
  const out = new Headers({ ...headers, location: '/' })
  out.append('set-cookie', `${COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`)
  out.append('set-cookie', `${STATE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`)
  return new Response(null, { status: 302, headers: out })
}

const html = (body, status) => new Response(body, { status, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } })
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const b64url = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const cookie = (request, name) => (request.headers.get('cookie') ?? '').split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1)

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))))
}

async function signedIn(request, env) {
  if (!env.SESSION_SECRET || !env.ALLOWED_EMAIL) return false
  const [exp, mac] = (cookie(request, COOKIE) ?? '').split('.')
  if (!exp || !mac || Number(exp) < Date.now()) return false
  const want = new TextEncoder().encode(await sign(env, `${exp}.${env.ALLOWED_EMAIL}`))
  const got = new TextEncoder().encode(mac)
  return got.length === want.length && crypto.subtle.timingSafeEqual(got, want)
}

function loginPage(error) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>dsh-market 数据</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:light-dark(#f4f3f0,#111110);color:light-dark(#0b0b0b,#f0efec);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
main{background:light-dark(#fcfcfb,#1a1a19);border:1px solid light-dark(#e3e2dd,#2e2e2c);border-radius:12px;padding:24px;width:300px;display:grid;gap:12px}
h1{font-size:18px;margin:0}a.btn{display:block;text-align:center;padding:9px 10px;border-radius:8px;background:#2a78d6;color:#fff;text-decoration:none}
.err{color:#d03b3b;margin:0}.muted{color:light-dark(#77766f,#9a998f);font-size:12px;margin:0}</style></head><body>
<main><h1>dsh-market 数据</h1>${error ? `<p class="err">${error}</p>` : '<p class="muted">仅限管理员账号。</p>'}
<a class="btn" href="/login">用 Google 登录</a></main></body></html>`
}
