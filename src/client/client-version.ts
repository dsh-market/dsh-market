/**
 * The version this client bundle was built as (tsdown `define`), or null in
 * tests and unbundled runs.
 *
 * The market can update itself while DSH keeps running: the new files are on
 * disk, the page loads the NEW bundle, but the server half already imported
 * stays the OLD version until it is reloaded. Comparing the two is how the
 * page knows it is talking to an older server, instead of failing on a route
 * that server does not have.
 */
declare const __DSHM_CLIENT_VERSION__: string | undefined

export const CLIENT_VERSION: string | null = typeof __DSHM_CLIENT_VERSION__ === 'string' ? __DSHM_CLIENT_VERSION__ : null

/** Numeric x.y.z comparison; prerelease tags are ignored. null if either is not a version. */
export function compareMarketVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
    return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const x = parse(a), y = parse(b)
  if (x === null || y === null) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? 1 : -1
  return 0
}

/** The server half is older than this page: it updated itself and has not been reloaded. */
export function serverIsBehind(serverVersion: string | null, clientVersion: string | null = CLIENT_VERSION): boolean {
  if (serverVersion === null || clientVersion === null) return false
  return (compareMarketVersions(clientVersion, serverVersion) ?? 0) > 0
}

/**
 * Ask the server to swap in the version the page already is (POST
 * /dsh-market/reload-self), and wait until it has.
 *
 * 200 means the new server half is serving. 202 means the host was busy with
 * another change and will do it when that ends: poll /status until the
 * version catches up, within a bound. Any other answer carries the reason in
 * plain words (`error`, zh / en); an empty one means the server could not say.
 */
export async function requestSelfReload(
  post: () => Promise<Response>,
  readVersion: () => Promise<string | null>,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await post()
  if (res.status !== 202) {
    if (res.ok) return { ok: true }
    const { body } = await readMarketJson<{ error?: string }>(res)
    return { ok: false, error: typeof body.error === 'string' ? body.error : '' }
  }
  const pollMs = options.pollMs ?? 1000
  const deadline = Date.now() + (options.timeoutMs ?? 120_000)
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    const version = await readVersion().catch(() => null)
    if (version !== null && !serverIsBehind(version)) return { ok: true }
  }
  return { ok: false, error: '' }
}

/**
 * Read a JSON reply; an empty or non-JSON body from a route this server does
 * not have (the host answers 404/405 with nothing) becomes `stale-server`,
 * never a JSON parse error.
 */
export async function readMarketJson<T extends object>(res: Response): Promise<{ ok: boolean; status: number; body: T & { code?: string; error?: string } }> {
  const text = await res.text().catch(() => '')
  try {
    return { ok: res.ok, status: res.status, body: JSON.parse(text) as T & { code?: string; error?: string } }
  } catch {
    const stale = res.status === 404 || res.status === 405
    return { ok: false, status: res.status, body: { code: stale ? 'stale-server' : 'bad-reply', error: '' } as T & { code?: string; error?: string } }
  }
}
