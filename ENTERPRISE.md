# Enterprise and private plugin sources

[中文](ENTERPRISE.zh.md)

dsh-market can add your organization's own plugins next to the public catalog: private catalogs, private npm, internal Git and offline bundles. An administrator can also use one policy file to decide what people may install and where the market may connect.

**With nothing configured, the market behaves exactly as before.** Everything below is optional.

- [Additional catalogs](#additional-catalogs)
- [Private npm](#private-npm)
- [Internal Git](#internal-git)
- [Offline bundles](#offline-bundles)
- [The policy file, policy.json](#the-policy-file-policyjson)
- [Security boundaries](#security-boundaries)

## Additional catalogs

A catalog is a `plugins.json` in the same shape as the public one. Host it at any internal HTTP address, or keep it as a file on the machine.

**Added by a user**: market settings → Advanced → Plugin catalogs → Add catalog, then enter a URL or an absolute file path. The market reads it once and shows how many plugins it has, or why it could not be read, before saving.

**Set by an administrator**: list it under `catalogs` in the [policy file](#the-policy-file-policyjson). People see it but cannot remove it.

Once added:

- Its plugins appear on Discover next to the public ones, tagged with their source (for example "Acme internal"). With more than one source, a source filter appears.
- If the same plugin is in two catalogs, the private one wins and only one card is shown. Private plugins sort first.
- A catalog that cannot be read (offline, 401, bad format) affects only itself. A notice says which catalog, why, and how to retry; the others keep working.
- AI search, AI recommendations and `/find-plugin` include private plugins.

### Making a catalog file

The repository has a script that builds `plugins.json` from a short list. Scripts are not in the npm package, so clone the repository first:

```bash
git clone https://github.com/dsh-market/dsh-market && cd dsh-market
node scripts/make-catalog.mjs entries.json -o plugins.json --label "Acme internal"
```

`entries.json`:

```json
[
  { "npm": "@acme/dsh-notify", "category": "tools" },
  { "npm": "dsh-loop", "category": ["tools", "automation"], "description": "Loop a task" },
  { "repo": "https://github.com/acme/dsh-theme", "category": "themes",
    "description": { "zh": "公司主题", "en": "Company theme" } }
]
```

The script fills in anything missing (name, description, repository) from the package's own `package.json`. For private scopes it uses `@scope:registry=` and the matching token from `~/.npmrc`. With `--offline` it looks nothing up, and every entry must be complete.

Catalog entries may also carry:

| Field | Purpose |
|---|---|
| `npm` | Install by this package name (use it for private npm packages) |
| `git` | Install from internal Git, see [Internal Git](#internal-git) |
| `screenshots` | Screenshot URLs, any https host (hidden when the policy turns external images off) |

## Private npm

pnpm already reads the profile's `.npmrc`, so installing private packages only needs the registry and token there. This works the same for Verdaccio, Nexus, Artifactory and GitHub Packages:

```ini
# <profile>/.npmrc
@acme:registry=https://npm.acme.internal/
//npm.acme.internal/:_authToken=${ACME_NPM_TOKEN}
```

The market's own npm requests (update checks, versions, changelogs, compatibility reads) follow the same rules:

- A package uses its scope's `@scope:registry=`, from the profile `.npmrc` first, then `~/.npmrc`.
- An unscoped `registry=` in the profile `.npmrc` is used as the default registry. The same line in `~/.npmrc` is not read, so ordinary setups don't change.
- `_authToken`, `_auth` and `username` + `_password` are supported, with `${ENV}` expanded.
- A token is sent only to its own registry, and never appears in logs, exported logs or the browser.

GitHub Packages example:

```ini
@acme:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Internal Git

Give a catalog entry a `git` source over https or ssh, with an optional `#tag` or commit:

```json
{
  "name": "acme-review",
  "url": "https://gitlab.acme.internal/tools/acme-review",
  "category": "tools",
  "description": { "zh": "内部代码评审助手", "en": "Internal review helper" },
  "git": "git+ssh://git@gitlab.acme.internal/tools/acme-review.git#v1.2.0"
}
```

- Authentication uses the machine's own git credentials (ssh key, credential helper). The market never handles them.
- Passwords in the URL are refused.
- Only a `git` source written in a loaded catalog is installed. A source sent in a web request is ignored.

## Offline bundles

For machines that cannot reach npm: pack a catalog and its plugin files into one archive, copy it over, and import it.

**Pack** on a machine with network access:

```bash
node scripts/offline-pack.mjs --catalog plugins.json --out acme-offline.tgz
```

- `npm` entries are downloaded at the entry's `version`, or `latest` if none is given, and their integrity is checked.
- `git` entries are shallow-cloned and archived as they are. They are **source**: they install offline only if the repository commits what it runs.
- **Plugins with dependencies** are packed alone, and the script lists those dependencies. They are still fetched at install time. For a truly air-gapped network, run an internal npm mirror (Verdaccio, Nexus, …) and set it up as in [Private npm](#private-npm).

**Import**: market settings → Advanced → Plugin catalogs → Import offline bundle.

- The bundle becomes a local catalog whose plugins install from the files inside it, with no network.
- The import is strict. Any of the following refuses the whole bundle and writes nothing:
  - `..`, absolute paths, links or device files;
  - files other than `plugins.json` and `tarballs/*.tgz`;
  - more than 512 MB or more than 2000 files.
- Plugins installed from a bundle are not checked for updates. To update them, import a newer bundle.

An administrator can also unpack a bundle to a fixed place and point a policy `catalogs[].file` at it.

## The policy file, policy.json

A JSON file kept by an administrator. The market reads it and never writes it. The first one found wins:

1. env `DSH_MARKET_POLICY` (an absolute path)
2. macOS / Linux: `/etc/dsh-market/policy.json`; Windows: `%ProgramData%\dsh-market\policy.json`
3. `<DSH_HOME>/dsh-market/policy.json`

> **"People cannot change it" comes from file permissions.** Make locations 1 and 2 writable by administrators only (for example owned by `root`, mode `644`). Location 3 is in the user's own home, so it suits single-user setups and does not bind the user.

Full example (every field is optional):

```json
{
  "catalogs": [
    {
      "id": "acme",
      "label": { "zh": "Acme 内部", "en": "Acme internal" },
      "url": "https://plugins.acme.internal/plugins.json",
      "headers": { "Authorization": "Bearer ${ACME_PLUGINS_TOKEN}" }
    },
    { "id": "acme-offline", "label": "Acme offline", "file": "/opt/acme/dsh-offline" }
  ],
  "publicCatalog": true,
  "userCatalogs": false,
  "allow": ["@acme/*", "dsh-notify-me"],
  "pins": { "dsh-notify-me": "1.21.6" },
  "telemetry": false,
  "comments": false,
  "externalImages": false,
  "mirrors": {
    "catalog": "https://mirror.acme.internal/dsh/plugins.json",
    "npm": "https://npm.acme.internal",
    "githubProxy": "https://gh-proxy.acme.internal/"
  }
}
```

| Field | Default | Effect |
|---|---|---|
| `catalogs` | none | Additional catalogs. `id` uses lowercase letters, digits and `-`. Give either `url` or `file`. `${ENV}` in `headers` is expanded from the environment at request time and never logged |
| `publicCatalog` | `true` | `false` loads only your catalogs, not the public one |
| `userCatalogs` | `true` | `false` stops people adding catalogs, and stops loading ones already added |
| `allow` | anything | Plugins that may be installed, by npm name or entry name, with `*` as the only wildcard. Others can be browsed but not installed |
| `pins` | none | Fixed versions: installs get exactly this version, and updates are offered up to it at most. Cards say "Version set by your organization" |
| `telemetry` | `true` | `false` forces the anonymous usage count off and locks its switch |
| `comments` | `true` | `false` hides comments and never contacts giscus or GitHub |
| `externalImages` | `true` | `false` loads no outside images: screenshots, avatars, icons, README images |
| `mirrors` | by download region | Catalog, npm and GitHub proxy addresses. They take precedence over the `DSHM_*` variables and the download region, and people cannot change them |

Settings set by the policy show as locked, with "Set by your organization".

**A broken policy file** (not valid JSON) keeps browsing working but **pauses every install**. Settings name the file and the position of the error, and say to ask your administrator. An administrator who wrote a policy expects it to hold, so a policy that cannot be read is never quietly treated as "no policy". A single bad field is ignored on its own and reported; only a malformed `allow` is read as "allow nothing".

## Security boundaries

- The install route still accepts only **entries from loaded catalogs**. The list is now the union of every catalog, filtered by `allow`. A web page cannot make the local server install an arbitrary source.
- Adding and removing catalogs only accepts requests from the market's own page.
- Catalog `headers` and `.npmrc` tokens are used only on the server, and never appear in logs, exported logs or the browser.
- Install paths inside an offline bundle are resolved only on the server, and only to files inside that bundle.

See [SECURITY.md](SECURITY.md) for more.
