/**
 * Daily aggregates for the private dashboard. Raw rows stay in `pings`; the
 * hourly cron folds them into small tables the dashboard can read cheaply:
 *
 * - `installs`: per install id, the first day seen, the first day the market
 *   was opened and the last day seen. Needed for "new" and retention counts;
 *   deleted 400 days after the install was last seen, like `pings`.
 * - `rollup`: one JSON row of counts per finished UTC day (no ids).
 * - `retention`: per cohort (first day the market was opened), how many of
 *   them opened it again k days later; k = 0 is the cohort size.
 */

/** First UTC day with data (the count went live mid-day, about 07:00 UTC). */
export const START_DAY = '2026-11-20'
/** Market versions from this one on also report whether the page was opened. */
const OPENED_SINCE = [1, 73, 25]
const RETENTION_WINDOW = 35
const RETENTION_MAX_K = 30

export const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10)
export const shiftDay = (day, n) => utcDay(Date.parse(`${day}T00:00:00Z`) + n * 86400e3)

const parseV = v => v.split(/[.+-]/).slice(0, 3).map(x => parseInt(x, 10) || 0)
function compareVersions(a, b) {
  const x = parseV(a), y = parseV(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
const reportsOpened = v => compareVersions(v, OPENED_SINCE.join('.')) >= 0
const add = (map, key, n) => { map[key] = (map[key] ?? 0) + n }

/** Counts for one day. `windows` adds the 7- and 30-day distinct counts (slower). */
export async function computeDay(env, day, windows) {
  const { results } = await env.DB.prepare(`SELECT v, hv, region, kind, COUNT(*) AS n, SUM(opened) AS o
    FROM pings WHERE day = ? GROUP BY v, hv, region, kind`).bind(day).all()
  const d = { installs: 0, opened: 0, covered: 0, region: {}, kind: {}, v: {}, hv: {} }
  for (const r of results) {
    d.installs += r.n
    d.opened += r.o
    if (reportsOpened(r.v)) d.covered += r.n
    add(d.region, r.region, r.n)
    add(d.kind, r.kind, r.n)
    add(d.v, r.v, r.n)
    add(d.hv, r.hv ?? 'unknown', r.n)
  }
  const fresh = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM installs WHERE first_day = ?1) AS newInstalls,
    (SELECT COUNT(*) FROM installs WHERE first_open_day = ?1) AS newOpeners`).bind(day).first()
  Object.assign(d, fresh)
  if (windows) {
    const w = await env.DB.prepare(`SELECT
        COUNT(DISTINCT CASE WHEN day >= date(?1, '-6 days') AND opened = 1 THEN id END) AS wau,
        COUNT(DISTINCT CASE WHEN opened = 1 THEN id END) AS mau,
        COUNT(DISTINCT CASE WHEN day >= date(?1, '-6 days') THEN id END) AS wai,
        COUNT(DISTINCT id) AS mai
      FROM pings WHERE day BETWEEN date(?1, '-29 days') AND ?1`).bind(day).first()
    Object.assign(d, w)
  }
  return d
}

/** Fold recent pings into `installs`. With `all`, every day (first run). */
async function updateInstalls(env, since) {
  await env.DB.prepare(`INSERT INTO installs (id, first_day, first_open_day, last_day)
    SELECT id, MIN(day), MIN(CASE WHEN opened = 1 THEN day END), MAX(day) FROM pings WHERE day >= ? GROUP BY id
    ON CONFLICT (id) DO UPDATE SET
      first_day = MIN(installs.first_day, excluded.first_day),
      first_open_day = CASE
        WHEN installs.first_open_day IS NULL THEN excluded.first_open_day
        WHEN excluded.first_open_day IS NULL THEN installs.first_open_day
        ELSE MIN(installs.first_open_day, excluded.first_open_day) END,
      last_day = MAX(installs.last_day, excluded.last_day)
    WHERE excluded.first_day < installs.first_day OR excluded.last_day > installs.last_day
      OR (excluded.first_open_day IS NOT NULL
        AND (installs.first_open_day IS NULL OR excluded.first_open_day < installs.first_open_day))`).bind(since).run()
}

async function meta(env, key) {
  return (await env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(key).first())?.v ?? null
}
const setMeta = (env, key, value) => env.DB.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind(key, value)

async function updateRetention(env, today) {
  const from = shiftDay(today, -RETENTION_WINDOW)
  // CROSS JOIN keeps pings as the outer loop (a range on its primary key) and
  // looks installs up by id; the other order would scan pings per install.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM retention WHERE cohort >= ?').bind(from),
    env.DB.prepare(`INSERT INTO retention (cohort, k, n) SELECT first_open_day, 0, COUNT(*) FROM installs
      WHERE first_open_day >= ?1 AND first_open_day < ?2 GROUP BY first_open_day`).bind(from, today),
    env.DB.prepare(`INSERT INTO retention (cohort, k, n)
      SELECT i.first_open_day, CAST(julianday(p.day) - julianday(i.first_open_day) AS INTEGER) AS k, COUNT(*)
      FROM pings p CROSS JOIN installs i ON i.id = p.id
      WHERE p.day >= ?1 AND p.day < ?2 AND p.opened = 1
        AND i.first_open_day >= ?1 AND p.day > i.first_open_day
        AND p.day <= date(i.first_open_day, '+${RETENTION_MAX_K} days')
      GROUP BY i.first_open_day, k`).bind(from, today),
    setMeta(env, 'retention_through', shiftDay(today, -1)),
  ])
}

/** Hourly: bring installs, finished days and retention up to date. Idempotent. */
export async function runRollup(env, now = Date.now()) {
  const today = utcDay(now)
  const yesterday = shiftDay(today, -1)
  const firstRun = (await meta(env, 'installs_ready')) === null
  await updateInstalls(env, firstRun ? START_DAY : yesterday)
  if (firstRun) await setMeta(env, 'installs_ready', '1').run()

  const done = new Set((await env.DB.prepare('SELECT day FROM rollup').all()).results.map(r => r.day))
  for (let day = START_DAY; day < today; day = shiftDay(day, 1)) {
    if (done.has(day)) continue
    const data = await computeDay(env, day, true)
    await env.DB.prepare('INSERT OR REPLACE INTO rollup (day, data, computed_at) VALUES (?, ?, ?)')
      .bind(day, JSON.stringify(data), new Date(now).toISOString()).run()
  }
  if ((await meta(env, 'retention_through')) !== yesterday) await updateRetention(env, today)
}

/** Daily: drop rows past the 400-day retention promised in SECURITY.md. */
export async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pings WHERE day < date('now', '-400 days')"),
    env.DB.prepare("DELETE FROM installs WHERE last_day < date('now', '-400 days')"),
  ])
}

/** Everything the dashboard draws, in one response. */
export async function dashboard(env, now = Date.now()) {
  const today = utcDay(now)
  const rows = (await env.DB.prepare('SELECT day, data FROM rollup ORDER BY day').all()).results
  const days = rows.map(r => ({ day: r.day, ...JSON.parse(r.data) }))
  const have = new Set(days.map(d => d.day))
  // A finished day the cron has not folded yet (the first minutes after
  // midnight UTC), and today so far: counts only, no 7/30-day windows.
  for (const day of [shiftDay(today, -1), today]) {
    if (day < START_DAY || have.has(day)) continue
    days.push({ day, ...(await computeDay(env, day, false)), live: day === today, provisional: day !== today })
  }
  days.sort((a, b) => a.day.localeCompare(b.day))
  const retention = (await env.DB.prepare('SELECT cohort, k, n FROM retention WHERE cohort >= ? ORDER BY cohort, k')
    .bind(shiftDay(today, -60)).all()).results
  return { generatedAt: new Date(now).toISOString(), startDay: START_DAY, today, days, retention }
}
