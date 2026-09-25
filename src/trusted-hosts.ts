/**
 * The non-loopback authorities this deployment serves, and the one place the
 * market decides which of them its mutation fence may accept.
 *
 * DSH already fences its own `/api` on "Host is loopback or a declared
 * authority": `dsh web --trusted-host <name>` exists so a deployment reached
 * through a reverse proxy, a LAN name or a tunnel can be used at all, and the
 * host publishes the resulting list — plus the LAN literals it derived — on
 * its `webRuntime` service. The market's fence (#678) only knew loopback, so
 * behind nginx, where `proxy_set_header Host $http_host` forwards the name the
 * browser typed, every mutating route answered 403 `untrusted origin` to the
 * very page the market was served to, while every read kept working.
 *
 * The declaration is the trust anchor, never the request: an authority counts
 * only because an operator named it. A rebinding page sends its own name in
 * Host AND Origin; that name is in no declaration, so it stays refused.
 *
 * Entries are validated, not repaired. DSH refuses a `trustedHosts` value that
 * WHATWG parsing would rewrite (#678's sibling rule), because
 * `harness.internal/path` or `user@harness.internal` would otherwise authorize
 * whatever hostname parsing digs out of it. The market refuses the same shapes
 * and reports them, so a typo is visible instead of silently granting nothing —
 * or something larger than the operator meant.
 */

/** One authority split into the parts a match compares. */
export interface AuthorityParts {
  /** Hostname, lowercased, with IPv6 literals keeping their brackets. */
  readonly host: string
  /** Explicit port, or `''` for a port-less entry, which matches any port. */
  readonly port: string
}

/** The declarations a fence may accept, and the entries refused as unusable. */
export interface TrustedAuthorityList {
  /** Canonical, deduplicated `host[:port]` entries, in declaration order. */
  readonly authorities: string[]
  /** Entries that are not a bare authority, verbatim, for the caller to report. */
  readonly rejected: string[]
}

/**
 * Split one authority into comparable parts, or null when the entry is not a
 * bare `host[:port]`.
 *
 * The round trip is the test: whatever parsing would rewrite is refused rather
 * than narrowed into a grant. That rejects a path, userinfo (which would grant
 * the hostname buried inside it), a dangling colon or zero-padded port (which
 * would broaden an exact-port grant to every port), and a non-canonical
 * spelling such as `0x7f.0.0.1`. IDN hosts are declared in punycode, the form
 * the wire carries. Surrounding whitespace is trimmed: it cannot change which
 * authority is named.
 *
 * @param entry - the configured value, verbatim.
 * @returns the comparable parts, or null when the entry is not an authority.
 */
export function authorityParts(entry: string): AuthorityParts | null {
  const trimmed = entry.trim()
  if (trimmed === '') return null
  try {
    const url = new URL(`http://${trimmed}`)
    // The port is judged from URL parses under both special schemes — their
    // default ports differ, so a written `:80`/`:443` still counts as explicit
    // — and never from the raw string, where WHATWG trimming would misread
    // shapes like `host:port ` as port-less.
    const port = url.port !== '' ? url.port : new URL(`https://${trimmed}`).port
    const canonical = port === '' ? url.hostname : `${url.hostname}:${port}`
    if (canonical !== trimmed.toLowerCase()) return null
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

/**
 * Normalize declared entries: trim, refuse anything that is not a bare
 * authority, drop duplicates, and keep the order the operator wrote them in.
 *
 * Non-strings are refused too. They can only come from a host publishing a
 * malformed list or a `trustedHosts` entry that is not text, and both are
 * worth saying out loud rather than coercing.
 *
 * @param values - entries from every source, in precedence order.
 */
export function trustedAuthorities(values: Iterable<unknown>): TrustedAuthorityList {
  const authorities: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') {
      rejected.push(describeEntry(value))
      continue
    }
    const trimmed = value.trim()
    if (authorityParts(trimmed) === null) {
      rejected.push(value)
      continue
    }
    // Case cannot decide which authority is named, so it cannot decide
    // whether two entries are the same one either.
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    authorities.push(trimmed)
  }
  return { authorities, rejected }
}

/**
 * The authorities this deployment serves: what the host publishes, plus
 * whatever the market's own `trustedHosts` config adds.
 *
 * A host that exposes no `webRuntime` — or an older one whose service carries
 * no `trustedHosts` — contributes nothing and leaves the fence loopback-only,
 * which is the behaviour every release before this one had.
 *
 * @param source - the host's `webRuntime` service, read structurally.
 * @param declared - the market's own configured entries, if any.
 */
export function resolveTrustedHosts(source: unknown, declared?: Iterable<unknown>): TrustedAuthorityList {
  const published = source !== null && typeof source === 'object'
    ? (source as { trustedHosts?: unknown }).trustedHosts
    : undefined
  return trustedAuthorities([
    ...(Array.isArray(published) ? published : []),
    ...(declared === undefined ? [] : declared),
  ])
}

/** A rejected entry rendered for a log line, whatever type it arrived as. */
function describeEntry(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
