# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Use GitHub's
private vulnerability reporting instead:

<https://github.com/dsh-market/dsh-market/security/advisories/new>

That form is private between you and the maintainers, and it is the channel
this project checks. A public issue is fine for anything that is not a
security problem — an ordinary bug, a crash, a wrong message.

If the private form is unavailable to you, say so in an issue **without the
details** (no request paths, no payloads, no reproducer) and we will find
another channel first.

## What this project is, and what that means for severity

`dshmarket` is a plugin market that runs *inside* DeepSeek Harness. It is not
a standalone service:

- It holds **no credentials of its own** — no GitHub token, no account. Gist
  backups use a token the user pastes in per action, and nothing is stored.
  The one exception is opt-in: if the user turns on "Remember password" for
  WebDAV backup (off by default), that password is kept in
  `<DSH_HOME>/dsh-market/webdav.json` with mode 0600 — the host offers
  plugins no secret store. It lives outside the profile, so exported backups
  never contain it; it is never kept in browser storage, never logged, and is
  only used for the exact URL and username it was saved for. Turning the
  option off deletes the file. Anything running as the same OS user can read
  it, which is why it is not the default.
- Its HTTP routes are registered with the host's web server and are meant to
  be reachable only where the host is reachable. It does not implement its
  own login.
- It runs shell commands (`pnpm`, `dsh plugin`, `git`) against the user's own
  profile, by design — that is what installing a plugin is.

The most useful reports are about the boundaries: a request that reaches a
mutating route without the host authenticating it; a plugin install that
reads or writes outside the profile it was pointed at; a place where a
plugin's own metadata (its name, its manifest, a URL in its spec) is trusted
for something it should not be.

## Anonymous usage count

The market sends one anonymous count a day. It is on by default and can be
turned off. It is sent from the Node side of the plugin, never from the
browser, and never carries a path, a plugin list, a hostname or a username.

- **Fields**, five, as JSON: `id` (a random 128-bit hex string made on
  first use and kept in `<DSH_HOME>/dsh-market/telemetry.json`), `v` (market
  version), `hv` (DSH version, or null), `kind` (`desktop` or `web`) and
  `region` (the download region, `global` or `china`). On a day the user
  opens the market page, one more post carries the same five plus
  `opened: true`: only that the page was opened, never which tab, search,
  plugin or how long.
- **Endpoint**: `POST https://t.dshmarket.com/v1/ping`, at most once per UTC
  day per install for the count and once more for `opened`, with a 10 second timeout. A failure is not retried before
  the next scheduled check and never surfaces as an error.
- **Retention**: rows older than 400 days are deleted. We do not store the
  sender's IP address.
  For the maintainers' private dashboard, each install id also keeps its
  first day seen, first day the market was opened and last day seen (to
  count new users and how many come back); that row is deleted 400 days
  after the install was last seen. Everything else is daily totals with no id.
- **Turn it off**: the "Anonymous usage count" switch in the market's card
  under Settings, which takes effect immediately and deletes nothing else; or
  set `DSH_MARKET_TELEMETRY=0` or `DO_NOT_TRACK=1` in the environment. It is
  also never sent when `CI` is set or under test runs.

## AI search, `/find-plugin` and AI recommendations

These call the model **you** configured in DSH, through DSH's own model
service, with your API key; the market runs no model and has no server of its
own in this path. What goes to that model: your request, and short catalog
entries (name, author, npm package name when available, categories, description,
download and star counts) for the candidates.

Your installed and favorited plugins (names and descriptions) are added only
in two cases: when you click *Let AI guess what you'd like*, for that one
call, or after you click *Allow* under an AI result, which keeps the choice in
`<DSH_HOME>/dsh-market/ai-consent.json` until you click *Stop* under a later
result. Nothing of this runs on its own: AI search runs on Enter with its
switch on, `/find-plugin` when you send it, recommendations when you click.

## Private catalogs and the policy file

An organization can add catalogs and set a read-only policy file
([ENTERPRISE.md](ENTERPRISE.md)). This does not widen what a web page can do:
the install route still accepts only entries from catalogs the server itself
loaded (the union of the public catalog, policy catalogs and the user's own),
filtered by the policy's `allow`; a source sent in a request body is never
installed. Adding or removing a catalog requires a same-origin request.
Catalog `headers` (with `${ENV}` expanded at request time) and `.npmrc`
credentials are used only for requests to their own host, and are masked in
logs and exported logs and never sent to the browser. An offline bundle is
unpacked only after every member passes a layout check (no `..`, absolute
paths, links or devices; only `plugins.json` and `tarballs/*.tgz`; size and
count caps), and its install paths resolve on the server, inside the bundle.
A policy file that is not valid JSON pauses all installs rather than being
read as no policy.

## Supported versions

The latest published version on npm is the one that gets fixes. There are no
maintained back-branches.
