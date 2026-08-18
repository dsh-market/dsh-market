/**
 * Locale registry — the single source of truth for internationalization.
 *
 * Mirrors the structure awesome-dsh-plugin uses, deliberately: the two sites
 * publish pages for the same 1,300 plugins, and a slug or hreflang that
 * disagrees between them is a page Google has to guess about.
 *
 * Adding a language:
 *   1. Add an entry here (copy an existing one, translate every string).
 *   2. Create site/index.<code>.html and site/privacy.<code>.html.
 * Plugin pages, the browse index, hreflang sets and the sitemap follow.
 *
 * The first entry is the default locale (x-default, served at /).
 */
export default [
  {
    code: 'en',
    htmlLang: 'en',
    label: 'EN',
    urlPath: '/',
    index: 'site/index.en.html',
    privacy: 'site/privacy.en.html',
    privacyPath: '/privacy/',
    browsePath: '/browse/',
    BROWSE_TITLE: 'Browse all {N} dsh plugins — dsh-market',
    BROWSE_DESC: 'Every plugin in the dsh-market catalog, grouped by category: {N} plugins for DeepSeek Harness with one-line install commands.',
    // Plugin page. Same reasoning as the catalog site: "dsh" is the phrase
    // people actually search, and the owner stays because it says who wrote
    // the thing you are about to run on your own machine.
    P_TITLE: '{NAME} — install for dsh · dsh-market',
    strings: {
      SKIPTO: 'Skip to content',
      NAV_GITHUB: 'GitHub',
      NAV_NPM: 'npm',
      NAV_BROWSE: 'Browse plugins',
      BROWSE_H1: 'All plugins',
      BROWSE_LEAD: 'Everything in the catalog, grouped by category. Install any of them from inside DeepSeek Harness with <code>dsh plugin --profile web add dshmarket</code>.',
      CRUMB_HOME: 'dsh-market',
      CRUMB_BROWSE: 'All plugins',
      P_INSTALL: 'Install',
      P_INSTALL_MARKET: 'Inside DeepSeek Harness, with dsh-market',
      P_INSTALL_CLI: 'Or from the command line',
      P_INSTALL_NOTE: 'Installing runs third-party code with your own permissions — it can read your files, use your credentials and reach the network. Review the source first, and pin a commit (<code>github:owner/repo#sha</code>) when you can.',
      P_SHOTS: 'Screenshots',
      P_ABOUT: 'About this plugin',
      P_FACTS: 'Details',
      P_STARS: 'Stars',
      P_CAT: 'Category',
      P_ADDED: 'Listed',
      P_NPM: 'npm',
      P_LINKS: 'Links',
      P_GH: 'GitHub repository ↗',
      P_NPM_LINK: 'npm package ↗',
      P_CATALOG: 'Entry in the awesome-dsh-plugin catalog ↗',
      P_RELATED: 'More in this category',
      P_README: 'README',
      P_README_SRC: 'Content from the project README on GitHub ↗',
      P_README_ONLY: 'This plugin publishes its README in {LANG} only.',
      COPY: 'copy',
      COPIED: 'Copied',
      PRIVACY: 'Privacy',
      BACK: '← Back',
    },
    langNames: { en: 'English', zh: 'Chinese' },
  },
  {
    code: 'zh',
    htmlLang: 'zh-CN',
    label: '中文',
    urlPath: '/zh/',
    index: 'site/index.zh.html',
    privacy: 'site/privacy.zh.html',
    privacyPath: '/zh/privacy/',
    browsePath: '/zh/browse/',
    BROWSE_TITLE: '全部 {N} 个 dsh 插件 — dsh-market',
    BROWSE_DESC: 'dsh-market 收录的全部插件，按分类归组：{N} 个 DeepSeek Harness 插件，附一行安装命令。',
    P_TITLE: '{NAME} — dsh 插件安装 · dsh-market',
    strings: {
      SKIPTO: '跳到正文',
      NAV_GITHUB: 'GitHub',
      NAV_NPM: 'npm',
      NAV_BROWSE: '浏览插件',
      BROWSE_H1: '全部插件',
      BROWSE_LEAD: '目录里的全部插件，按分类归组。在 DeepSeek Harness 里用 <code>dsh plugin --profile web add dshmarket</code> 即可安装其中任意一个。',
      CRUMB_HOME: 'dsh-market',
      CRUMB_BROWSE: '全部插件',
      P_INSTALL: '安装',
      P_INSTALL_MARKET: '在 DeepSeek Harness 里通过 dsh-market 安装',
      P_INSTALL_CLI: '或使用命令行',
      P_INSTALL_NOTE: '装任何插件都等于在你的机器上跑第三方代码，权限和你本人一样大——能读你的文件、用你的凭据、访问网络。请先审阅源码，并尽量锁定 commit（<code>github:owner/repo#sha</code>）。',
      P_SHOTS: '截图',
      P_ABOUT: '关于这个插件',
      P_FACTS: '详情',
      P_STARS: 'Star 数',
      P_CAT: '分类',
      P_ADDED: '收录于',
      P_NPM: 'npm',
      P_LINKS: '链接',
      P_GH: 'GitHub 仓库 ↗',
      P_NPM_LINK: 'npm 包 ↗',
      P_CATALOG: '在 awesome-dsh-plugin 目录中的条目 ↗',
      P_RELATED: '同类插件',
      P_README: 'README',
      P_README_SRC: '内容来自项目 README（GitHub）↗',
      P_README_ONLY: '该插件的 README 只有{LANG}版本。',
      COPY: '复制',
      COPIED: '已复制',
      PRIVACY: '隐私政策',
      BACK: '← 返回',
    },
    langNames: { en: '英文', zh: '中文' },
  },
]
