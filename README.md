<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-market logo">
</p>

# dsh-market

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dshmarket)](https://www.npmjs.com/package/dshmarket)
[![stars](https://img.shields.io/github/stars/dsh-market/dsh-market?style=flat)](https://github.com/dsh-market/dsh-market)

The plugin market inside DeepSeek Harness. Open Settings → **Plugin Market** → browse, search, one-click install.

![dsh-market](assets/demo-en.png)

One-click themes — install, switch live, no restart:

![Themes tab](assets/themes-en.png)

## Install

```sh
dsh plugin --profile web add dshmarket
```

Restart `dsh web`, then open **Settings → Plugin Market**.

## What you get

- **Browse & search** the full community catalog (800+ plugins, growing daily) — category filters, star counts, top/new sorting, bilingual descriptions that follow your UI language
- **Screenshots** — AppStore-style screenshots in the install dialog: author-curated via the registry, with automatic README extraction as fallback; images load from GitHub hosting only, and only after you open the dialog
- **Themes** — a dedicated tab for community themes and skins: install → active immediately, switch with one click (themes are mutually exclusive, your choice survives restarts), uninstall to revert
- **One-click install** — confirm the source, watch live progress; most plugins go live after a page refresh, no restart
- **Backup & restore** — export your profile's plugin list and configuration as readable JSON, import it on another machine, store it on WebDAV with daily auto-backup, or sync through a private GitHub Gist; restores **merge** (plugins installed after the backup are kept), validate before writing, and roll back on failure
- **Updates** — per-plugin update checks (npm version or pinned commit vs HEAD), one-click update, or update everything at once; the market updates itself the same way
- **Uninstall** — two-step confirm; plugins installed this session are removed live
- **Hot disable / enable** — toggles write `- id: …` + `disabled: true|false` into the profile's `cordis.patch.yml` (the official patch layer, mechanism ported from [dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub)): DSH's HMR re-composes within ~1s, no restart, and the loader re-applies the choice on every boot; hand-edited patch rows show as badges, host-infrastructure plugins are protected from toggling, and a malformed patch file is never made worse
- **Restart when needed** — changes that cannot hot-load show a one-click restart beside the pending-change banner; the action is restricted to same-origin loopback requests
- **Zero jargon** — if a component is missing (pnpm), the market detects it and offers a one-click automatic setup
- **Log export** — one click produces a sanitized plain-text log for bug reports (home paths and credential shapes are masked; nothing is ever sent anywhere)
- **Diagnostics** — the plugin load order and conflict surface, one page: bundle stack with official/community badges, duplicate loader entries, dependency version mismatches, multi-version core packages, overrides and invalid config entries. Plain-language terms, problem blocks highlighted, everything collapsible

- **AI fix** — one click copies a diagnostics-driven fix prompt (errors/warnings/order conflicts + conservative scope instructions) to the clipboard; you paste it into a new conversation and decide whether to send

## Speed

Installs prefer npm tarballs over full-repo GitHub downloads whenever a plugin publishes to npm (registry-verified against the repo to prevent name squatting). Registry installs are typically seconds; GitHub-only plugins depend on your connection to GitHub.

## Security

- Installs are restricted to sources listed in the curated [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry — anything else is rejected
- Build scripts stay blocked by default (pnpm ≥10); allowing one is your explicit per-package choice
- Terminal/CLI-surface plugins are flagged before you install them into the web profile
- The install endpoint accepts same-origin POST only; the market never phones home
- Backups can contain credentials from your profile config — the UI warns before export and upload; WebDAV sync is https-only, refuses private-network targets, and never stores your password in the browser
- The restart endpoint additionally requires a direct loopback client (forwarded requests are rejected) and relaunches the exact DSH entry, arguments, environment, and working directory
- One-click restart launches a detached replacement. If DSH is managed by systemd, launchd, pm2, or another supervisor, set the plugin option `allowRestart: false` and let the supervisor own restarts instead; the pending-change notice remains visible but the button is hidden
- For terminal-attached launches, the detached replacement keeps running after the original terminal closes
- Listing ≠ endorsement: plugins are third-party code, install sources you trust

## Submit your plugin

**This repo is the market app, not the catalog.** The plugin list comes from the curated [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry — to get your plugin listed in the market, open a PR **there** (one entry in the list; the site and this market pick it up automatically, usually within a day). Please don't PR plugin entries against this repo.

## Roadmap & feedback

- Planned features live on the [Roadmap](https://github.com/orgs/dsh-market/projects/1) — every item welcomes community PRs (drop a note in the linked issue before starting)
- File bugs and ideas as [issues](https://github.com/dsh-market/dsh-market/issues); attaching the market's "Export log" makes diagnosis 10x faster

## Data source

Live from [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json) — curated entries, npm mapping, and star counts refreshed daily by CI — with a bundled snapshot as offline fallback.

## Friends

### DSH Desktop (dataelement)

[dsh-desktop](https://github.com/dataelement/dsh-desktop) — a desktop app for DeepSeek Harness: run and manage a local Harness without installing Node.js yourself. Ships with this plugin market preset as the default. [dshdesktop.com](https://dshdesktop.com)

### DeepSeek Harness Desktop (hairyf)

[deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop) — a native desktop app for DeepSeek Harness built with **Tauri** (Rust + Web): one-click local install and launch with no Node.js setup required. On first run it offers to install this plugin market as a recommended preset.

### DSH Get

[DSH Get](https://www.dshget.com/) — a searchable web directory for discovering DeepSeek Harness plugins: category filters, bilingual descriptions, install commands and per-plugin detail pages. Its normalized catalog snapshot is public at [bobby-sheng/dshget-data](https://github.com/bobby-sheng/dshget-data).

### modlens

[modlens](https://github.com/liustack/modlens) — the first vision plugin for DeepSeek Harness: bolts visual understanding onto text-only models like DeepSeek and GLM. Paste an image, get structured JSON evidence back — OCR, layout, semantics. Available right in this market:

```sh
dsh plugin --profile web add @liustack/modlens
```

## License

MIT · [dshmarket.com](https://dshmarket.com)
