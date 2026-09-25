/**
 * Minimal HTTP helpers shared by every market route: JSON serialization,
 * same-origin enforcement for mutating endpoints, and a size-capped JSON
 * body reader.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Write a JSON payload with no-store caching. */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Authorities this deployment serves besides loopback, as the HOST declared
 * them (`dsh web --trusted-host <name>`, plus the LAN literals it derives when
 * bound to 0.0.0.0). Installed once at mount from the host's `connection`
 * service — see src/index.ts — and empty when the host is older than that
 * service, which leaves every rule below exactly as it was.
 *
 * This is the half of #678 the market was missing (#729). DSH's own /api fence
 * accepts "loopback OR a declared authority"; the market's routes are `exact`
 * registrations on the bare webServer, and exact matches win over the fence's
 * prefix, so it never sees them and has to decide for itself. Deciding
 * loopback-only made every mutating route answer 403 on any deployment reached
 * by a name — a reverse proxy, a tunnel, a LAN hostname — while every read
 * kept working, so it read to the user as "the install button does nothing".
 *
 * The security argument is unchanged: the rebinding defence is that Host is
 * the one header an attacker's page cannot forge, and an authority reaches
 * this list only by being written into the deployment's configuration. An
 * undeclared name is still refused.
 */
let trustedHostsSource: () => readonly string[] = () => []

/** Point the fence at the host's declared authorities. Returns the previous source. */
export function setTrustedHostsSource(source: () => readonly string[]): () => readonly string[] {
  const previous = trustedHostsSource
  trustedHostsSource = source
  return previous
}

/**
 * Parse a bare `host[:port]` authority, or null when the value is not one.
 *
 * "Not one" is narrower than "`new URL` accepted it": an entry must survive
 * WHATWG parsing UNCHANGED. `dsh.example.org/path` parses to the hostname
 * `dsh.example.org`, and treating that as a declaration would authorize a name
 * the operator never wrote (the host's own fence refuses such entries when the
 * configuration loads, loudly, for the same reason).
 */
function parseAuthority(value: string): URL | null {
  try {
    const url = new URL(`http://${value}`)
    const canonical = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`
    return canonical === value.toLowerCase() ? url : null
  } catch {
    return null
  }
}

/**
 * Whether a request authority is one of the declared ones.
 *
 * Mirrors @deepseek-ai/dsh-client-connection's rule, because the two fences
 * have to agree: an entry with an explicit port matches that exact authority,
 * a port-less entry matches the hostname on any port (the shape the CLI
 * derives for IP-literal LAN serving, where the bound port may be assigned by
 * the OS). Both sides compare through WHATWG normalization, so case and a
 * redundant `:80` never decide trust.
 */
export function trustedAuthority(host: string, trustedHosts: readonly string[]): boolean {
  const hostUrl = parseAuthority(host)
  if (hostUrl === null) return false
  return trustedHosts.some(entry => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === null) return false
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
  })
}

/**
 * True when the request's Origin, IF IT HAS ONE, matches its Host — required
 * on every POST route.
 *
 * An absent Origin is allowed (#648). The check exists to stop another web
 * page from driving this loopback API, and the Fetch spec has browsers send
 * `Origin` on every POST — including same-origin and cross-origin form
 * submissions. A request that arrives WITHOUT it therefore did not come from
 * a page at all, and a non-browser client can set any Origin it likes, so
 * refusing the header's absence bought nothing while breaking a whole
 * supported host: the Desktop app's own proxy strips `origin`, `host`,
 * `cookie` and `sec-fetch-site` before forwarding to the in-process host and
 * injects a cookie only that host can sign. Every mutating request from the
 * Desktop build was answered 403 `untrusted origin`.
 *
 * What still holds after the change, and is the part worth keeping:
 *
 * - a cross-site page is refused — its Origin is present and different;
 * - `Origin: null` (a sandboxed iframe, a `data:` document) is refused, because
 *   `null` is a present-but-unparseable origin, not an absent one;
 * - a same-host-but-different-port request is refused;
 * - an EMPTY Origin is refused too: the header being present and unparseable
 *   is not the same statement as its being absent, and only absence is what
 *   a stripping proxy produces.
 *
 * The header's absence is a statement about the client, not about intent, and
 * the intent is the only thing this can judge.
 *
 * @param request - the incoming request.
 * @returns whether the request may mutate market state.
 */
/**
 * Whether a `Host` header names a loopback authority (#678).
 *
 * `Origin === Host` alone does not stop a DNS-rebinding page: the attacker
 * serves their page from `evil.com`, resolves that name to 127.0.0.1, and
 * the browser then connects to the loopback listener while sending
 * `Origin: http://evil.com` AND `Host: evil.com` — an equality that holds
 * for the attacker. `Host` is the one header the attack cannot forge, so it
 * is what has to name a loopback authority.
 *
 * `localhost` is included because browsers and RFC 6761 pin it to loopback;
 * a subdomain like `localhost.evil.com` does not match, and the port is
 * dropped before comparing.
 *
 * @param host - the request's `Host` header.
 * @returns whether it names a loopback authority.
 */
export function loopbackAuthority(host: string | undefined): boolean {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  // IPv6 literals keep their brackets; `[::1]:3080` → `[::1]`.
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]!
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

export function sameOrigin(request: IncomingMessage): boolean {
  // The rebinding defence (#678): a page on `evil.com` aimed at 127.0.0.1
  // sends a matching Origin/Host pair, so the equality below cannot see the
  // attack — Host is what it cannot forge.
  //
  // An ABSENT Host is a different statement. Every browser sends Host, so a
  // request without one did not come from a page at all — the same argument
  // the Origin rule above rests on — while a stripping proxy (the Desktop
  // build's, #648) may remove it and must not be refused for it. So the
  // authority is only checked when it is present, and a rebinding page can
  // never reach the branch that skips it.
  const host = request.headers.host
  if (host !== undefined && !loopbackAuthority(host) && !trustedAuthority(host, trustedHostsSource())) return false
  // A browser states when IT considers a request cross-site, and the host's
  // own fence refuses that outright. Cheap, and it covers what the Origin
  // equality cannot: a cross-site request whose Origin happens to match.
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // A missing Origin is not a cross-site request: browsers send it on every
  // POST, same-origin included, so its absence means the caller is not a
  // page — and a non-browser client can set any Origin it likes, so
  // refusing the absence bought nothing while breaking the Desktop proxy,
  // which strips it (#648).
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, rejecting anything over 4 KiB. */
export async function readJsonBody(request: IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}
