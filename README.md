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

### DSH Desktop

On DSH Desktop builds that expose the public `desktopProfiles` and
`desktopPnpm` services, install from **Open DSH Terminal** with:

```sh
dsh plugin add dshmarket
```

The market automatically targets the immutable active Desktop profile and
uses Desktop's packaged pnpm operation service. It does not probe or install a
system pnpm, and Desktop keeps ownership of application restart. Ordinary DSH
continues to use the existing profile/argv/CLI path when those services are
absent. The detection order follows Desktop's supported
[cross-environment plugin contract](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.md#cross-environment-plugin-optional-desktop-adapter-and-ordinary-dsh-fallback).
This compatibility does not mean the market is bundled with Desktop.

## What you get

- **Browse & search** the full community catalog (300+ plugins, growing daily) — category filters, star counts, top/new sorting, bilingual descriptions that follow your UI language
- **Themes** — a dedicated tab for community themes and skins: install → active immediately, switch with one click (themes are mutually exclusive, your choice survives restarts), uninstall to revert
- **One-click install** — confirm the source, watch live progress; most plugins go live after a page refresh, no restart
- **Updates** — per-plugin update checks (npm version or pinned commit vs HEAD), one-click update, or update everything at once; the market updates itself the same way
- **Uninstall** — two-step confirm; plugins installed this session are removed live
- **Restart when needed** — changes that cannot hot-load show a one-click restart beside the pending-change banner; the action is restricted to same-origin loopback requests
- **Zero jargon** — if a component is missing (pnpm), the market detects it and offers a one-click automatic setup
- **Log export** — one click produces a sanitized plain-text log for bug reports (home paths and credential shapes are masked; nothing is ever sent anywhere)

## Speed

Installs prefer npm tarballs over full-repo GitHub downloads whenever a plugin publishes to npm (registry-verified against the repo to prevent name squatting). Registry installs are typically seconds; GitHub-only plugins depend on your connection to GitHub.

## Security

- Installs are restricted to sources listed in the curated [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry — anything else is rejected
- Build scripts stay blocked by default (pnpm ≥10); allowing one is your explicit per-package choice
- Terminal/CLI-surface plugins are flagged before you install them into the web profile
- The install endpoint accepts same-origin POST only; the market never phones home
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

## Related projects

### DeepSeek Harness Desktop

[DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) is a modern desktop client for the DeepSeek Harness ecosystem — start and manage a local Harness service without a system Node.js installation. Compatible builds can host a user-installed dsh-market through their public profile and package-operation services; bundling remains a Desktop project decision.

[Website](https://www.dshdesktop.cn) · [GitHub](https://github.com/anywhere-labs/deepseek-harness-desktop)

## License

MIT · [dshmarket.com](https://dshmarket.com)
