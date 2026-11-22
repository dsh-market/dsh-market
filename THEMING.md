# Theming the market panel (for theme authors)

> **Status: a description, not a promise.** Everything here is true of the
> market as shipped today (1.77.x). Token *names* belong to the host's alias
> layer, not to the market; the market neither defines nor owns them, so what
> "overriding a token" does is set by the host. What the market does promise
> is the last section: the targeting surface that is deliberately stable.

## How the market takes color

Every color in the market resolves through a host alias token with the
original light-mode literal as fallback:

```css
color: var(--dsw-alias-label-primary, #1f2328);
```

The market ships no dark stylesheet of its own (one block aside, keyed on the
host's `body[data-ds-dark-theme]`); dark is expected to arrive through the
tokens, the same way the host's own dark mode works. So the theming contract
is:

- the **host** defines the stock value of every token;
- a **theme** overrides tokens — at `body` scope, so everything inherits them,
  and through `body[data-ds-dark-theme]` for the dark variant;
- **plugins** (the market included) only consume.

A token a theme does not override keeps the stock value. That is invisible on
host pages, where a theme can patch the host's DOM by selector — and visible
inside plugin-owned DOM, which no theme can enumerate. This is why an
under-covered theme shows its gaps in the market panel first: segmented tab
rows on the stock platform fill, selected pills in stock ghost-active colors,
stock primary buttons, dialogs, toasts, tooltips, scrollbars. The fix is not
in the market; it is the rest of the token list in the theme.

## Tokens the market reads

The market's own sheet plus the host primitives it imports (`Button`, `Input`,
`Menu`, `Pill`, `Modal`, `Toast`, `Tooltip`, `StateDot`, `DisclosureRow`)
consume these alias tokens. A theme that overrides all of them leaves the
panel no stock color to fall back to, light or dark:

- **backgrounds** — `bg-base`, `bg-layer-1`, `bg-layer-2`, `bg-layer-3`,
  `bg-mask-1`, `bg-module-platform`
- **borders** — `border-l1`, `border-l2`, `border-l3`, `border-l4`
- **buttons** — `button-primary-fill`, `button-primary-hover`,
  `button-ghost-active-fill`, `button-ghost-active-border`,
  `button-tool-bar-fill`, `button-tool-bar-hover`
- **interactive** — `interactive-bg-hover`, `interactive-bg-active`,
  `interactive-bg-hover-danger`
- **labels** — `label-primary`, `label-primary-foreground`,
  `label-secondary`, `label-tertiary`, `label-caption`, `label-dimmed`,
  `brand-primary`, `link`
- **menus** — `menu-group-header-fill`, `menu-icon`
- **scrollbars** — `scrollbar-bg-l2`, `scrollbar-hover-l2`
- **settings cards** — `settings-card-fill`, `settings-card-stroke`
- **states** — `state-business-primary`, `state-error-primary`,
  `state-idle-primary`, `state-warn-primary`, `state-warn-label`,
  `state-warn-tertiary`, `state-success-primary`, `state-success-tertiary`
- **toast** — `toast-bg`, `toast-label`, `toast-action`
- **tooltip** — `tooltip-bg`, `tooltip-label`

Geometry comes through too — `--dsw-radius-xs/sm/md/lg/xl/panel`,
`--dsw-shadow-lv1/lv2/lv3`, `--dsw-focus-ring-width/color`,
`--ds-font-family-code` — but every one of those has a usable fallback, and
radius/shadow in particular are a whole-app look decision a theme should make
deliberately, not as a side effect of fixing colors.

The authoritative source is the CSS itself: `src/client/Market.module.css`
here, and the `*.module.css` files of the primitives package listed above.

## Targeting surface (stable)

Class names in the market's sheet are build hashes (`nUhMVa_tab` today,
something else next release) — never target them. These are the hooks that
exist to be targeted:

| hook | what it is |
|---|---|
| `[data-dsh-market-root]` | the panel root, in every surface |
| `[data-dsh-market-plugins-tab="true"]` | the root when mounted on the host's Plugins page (as opposed to the settings section or the sidebar page) |
| `[data-dsh-market-tab="<id>"]` | which tab body is shown: `installed`, `discover`, `favorites`, `themes`, `backup`, `diagnostics`, `blocked` |
| `[data-dsh-market-fullscreen="true"]` | the Themes tab in fullscreen |
| `[data-dshm-stuck="true"]` | a sticky row sitting on its sticky line (see below) |
| `--dshm-sticky-bg`, `--dshm-stuck-bg` | the sticky rows' surface; they fall back to `--dsw-alias-bg-base` |
| `style[data-plugin-css="dshmarket/Market.module.css"]` | the injected stylesheet itself, if a theme needs to reason about it |

Scope examples:

```css
/* Only the market panel, only under a specific theme's body attribute: */
body[data-dsh-maid-atelier] [data-dsh-market-root] { ... }

/* Only the Discover tab: */
[data-dsh-market-tab='discover'] { ... }
```

## The transparent-base contract

A wallpaper theme sets `--dsw-alias-bg-base: transparent` so the host page
background shows through. The market's sticky search and category rows are
the one thing standing between that transparency and the cards scrolling
underneath them, so such a theme must also set:

```css
--dshm-sticky-bg: <glass>;
--dshm-stuck-bg: <denser glass>;
```

With both unset the rows are transparent in flow (usually what the theme
wants) and stay transparent when pinned (which it does not). The rows carry
`[data-dshm-stuck]` while pinned, so a theme can also add a backdrop blur or
a border at the moment it matters:

```css
[data-dshm-stuck='true'] { backdrop-filter: blur(14px) saturate(0.9); }
```

## Worked example

[maid-atelier](https://github.com/flaricy/maid-atelier-ui-bundle) is a
wallpaper skin that hit exactly this: 41 tokens overridden, the rest of the
panel in stock colors. Its fix — reproduced as
[PR #3](https://github.com/flaricy/maid-atelier-ui-bundle/pull/3) — appends
the remaining 31 tokens to both body blocks, mapped onto the skin's navy /
gold / porcelain palette, and sets the two sticky vars. The shape of such a
patch:

```css
body[data-dsh-maid-atelier] {
  --dsw-alias-bg-module-platform: rgba(255, 253, 248, 0.7);
  --dsw-alias-button-ghost-active-fill: rgba(197, 164, 104, 0.24);
  --dsw-alias-button-ghost-active-border: rgba(197, 164, 104, 0.64);
  --dsw-alias-button-primary-fill: #536eae;
  --dsw-alias-link: #536eae;
  --dsw-alias-settings-card-fill: rgba(248, 250, 255, 0.9);
  /* ... the rest of the list above, light values ... */
  --dshm-sticky-bg: var(--maid-glass);
  --dshm-stuck-bg: rgba(248, 250, 255, 0.94);
}

body[data-dsh-maid-atelier][data-ds-dark-theme] {
  /* the same list, dark values */
}
```

## What this document promises

- The **data attributes** and the **`--dshm-*` variables** in the targeting
  table are the market's intended stable surface; changes to them will be
  called out in release notes.
- The **token list** reflects what the market consumes today. It grows when
  the market adopts another primitive or the host adds an alias layer; a
  theme missing the newcomers falls back to stock for those spots, which is
  the same failure mode this document exists to fix. When the list moves,
  the move lands in `Market.module.css` and its imports first — treat the
  CSS as the source of truth between doc updates.
