window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-market client: registers a "Market" settings section rendering the
 * plugin market UI. Hand-authored CJS bundle (no build step); the only
 * external is the loader module table's `react`.
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useMemo, useCallback } = React

const NS = 'dsh-market'

const zh = {
  nav: '插件市场',
  subtitle: '发现社区为 DeepSeek Harness 打造的能力',
  searchPh: '搜索插件，比如：通知、终端、记忆…',
  tabDiscover: '发现',
  tabInstalled: '已安装',
  all: '全部',
  install: '安装',
  installing: '安装中…',
  installedBadge: '✓ 已装好',
  alreadyInstalled: '✓ 已安装',
  restartBanner: '项变更完成，重启 DeepSeek Harness 后生效',
  uninstall: '卸载',
  confirmRemove: '确认卸载？',
  uninstalling: '卸载中…',
  restartHint: '重启方式：关闭当前 dsh 进程后重新运行（例如 dsh web）',
  confirmTitle: '安装',
  confirmWarn: '插件是社区第三方代码。安装即表示你信任该来源；构建脚本默认被禁止执行。',
  cancel: '取消',
  empty: '没有匹配的插件',
  installedEmpty: '还没有装过社区插件，去「发现」页逛逛吧',
  loadFail: '插件目录加载失败，请稍后重试',
  installFail: '安装失败',
  viewSource: '源码',
  hotBanner: '个新插件已装好，刷新页面即可使用',
  refresh: '刷新页面',
  update: '更新',
  updating: '更新中…',
  updated: '✓ 已更新，重启后生效',
  updateFail: '更新失败',
  upToDate: '已是最新',
  linkedDev: '本地开发链接',
  exportLog: '导出日志',
  readme: '使用说明',
  terminalWarn: '这看起来是终端/命令行插件：装进网页版可能无效，甚至导致 DeepSeek Harness 无法启动。建议先看它的使用说明，按说明装进对应的 profile。',
  envMissing: '还差一个小组件才能安装插件',
  envFix: '自动装好',
  envFixing: '正在准备…',
  envFixFail: '自动准备没成功，请点"导出日志"把文件发给我们反馈',
  loading: '正在加载插件目录…',
  backTop: '回到顶部',
  sortHot: '最热',
  sortNew: '最新',
  marketUpdate: '市场有新版本，升级',
  progressHint: '首次安装需要下载与解析依赖，大插件可能要 1-3 分钟',
  toastReady: '已装好并已生效',
  gotIt: '知道了',
}

const en = {
  nav: 'Plugin Market',
  subtitle: 'Discover community plugins for DeepSeek Harness',
  searchPh: 'Search plugins: notify, terminal, memory…',
  tabDiscover: 'Discover',
  tabInstalled: 'Installed',
  all: 'All',
  install: 'Install',
  installing: 'Installing…',
  installedBadge: '✓ Installed',
  alreadyInstalled: '✓ Installed',
  restartBanner: 'change(s) done — restart DeepSeek Harness to apply',
  uninstall: 'Uninstall',
  confirmRemove: 'Confirm?',
  uninstalling: 'Removing…',
  restartHint: 'To restart: stop the current dsh process and run it again (e.g. dsh web)',
  confirmTitle: 'Install',
  confirmWarn: 'Plugins are third-party community code. Installing means you trust this source; build scripts are blocked by default.',
  cancel: 'Cancel',
  empty: 'No plugins match',
  installedEmpty: 'No community plugins yet — browse the Discover tab',
  loadFail: 'Failed to load the plugin catalog, please retry later',
  installFail: 'Install failed',
  viewSource: 'Source',
  hotBanner: 'new plugin(s) ready — refresh the page to use them',
  refresh: 'Refresh',
  update: 'Update',
  updating: 'Updating…',
  updated: '✓ Updated — restart to apply',
  updateFail: 'Update failed',
  upToDate: 'Up to date',
  linkedDev: 'linked (dev)',
  exportLog: 'Export log',
  readme: 'README',
  terminalWarn: 'This looks like a terminal/CLI plugin: installing it into the web profile may do nothing, or even break DeepSeek Harness startup. Read its README and install it into the profile it targets.',
  envMissing: 'One small component is needed before installing plugins',
  envFix: 'Set up automatically',
  envFixing: 'Setting up…',
  envFixFail: 'Automatic setup failed — please use "Export log" and send us the file',
  loading: 'Loading the catalog…',
  backTop: 'Back to top',
  sortHot: 'Top',
  sortNew: 'New',
  marketUpdate: 'Market update available — upgrade',
  progressHint: 'First installs download and resolve dependencies — large plugins can take 1-3 minutes',
  toastReady: 'installed and live',
  gotIt: 'Got it',
}

const CSS = `
.dshm-root{height:100%;display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary,#1f2328);position:relative}
.dshm-head{padding:4px 4px 12px}
.dshm-title{font-size:16px;font-weight:700;margin:0}
.dshm-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:2px}
.dshm-search{margin-top:12px}
.dshm-search input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:8px 12px;font-size:13px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;outline:none}
.dshm-search input:focus{border-color:var(--dsw-alias-brand-primary,#4f6ef7)}
.dshm-tabs{display:flex;gap:2px;margin-top:10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.dshm-tab{border:none;background:none;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary,#6b7280);padding:7px 12px;cursor:pointer;border-bottom:2px solid transparent}
.dshm-tab.on{color:var(--dsw-alias-brand-primary,#4f6ef7);border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}
.dshm-restart{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-2,#fdf3e3);border:1px solid var(--dsw-alias-border-l1,#f3e3c3);border-radius:8px;padding:8px 12px;font-size:12px;margin:10px 4px 0}
.dshm-body{flex:1;overflow-y:auto;padding:12px 4px 24px}
.dshm-cats{display:flex;gap:6px;flex-wrap:wrap;position:sticky;top:-13px;z-index:5;background:var(--dsw-alias-bg-layer-1,#fff);padding:10px 0;margin:-10px 0 6px;align-items:center}
.dshm-sort{margin-left:auto;display:flex;gap:2px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:8px;padding:2px;flex-shrink:0}
.dshm-sort button{border:none;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);padding:3px 10px;border-radius:6px;cursor:pointer}
.dshm-sort button.on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.dshm-star{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af)}
.dshm-top{position:absolute;right:18px;bottom:18px;z-index:20;width:38px;height:38px;border-radius:99px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font-size:16px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.12)}
.dshm-top:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}
.dshm-chip{font:inherit;font-size:12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:99px;padding:3px 11px;cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280)}
.dshm-chip.on{background:var(--dsw-alias-button-primary-fill,#4f6ef7);border-color:var(--dsw-alias-button-primary-fill,#4f6ef7);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.dshm-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}
.dshm-row1{display:flex;align-items:center;gap:9px;min-width:0}
.dshm-av{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-weight:700;color:#fff;font-size:14px;flex-shrink:0}
.dshm-nm{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-owner{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af)}
.dshm-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.55;min-height:2.4em}
.dshm-foot{display:flex;align-items:center;gap:8px;margin-top:2px}
.dshm-cat{font-size:10px;color:var(--dsw-alias-label-secondary,#9ca3af);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:99px;padding:1px 8px}
.dshm-grow{flex:1}
.dshm-src{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);text-decoration:none}
.dshm-src:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}
.dshm-btn{border:none;border-radius:7px;padding:5px 14px;font:inherit;font-size:12px;cursor:pointer;font-weight:600}
.dshm-btn.install{background:var(--dsw-alias-button-primary-fill,#4f6ef7);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshm-btn.busy{opacity:.65;cursor:default}
.dshm-btn.done{background:transparent;color:var(--dsw-alias-state-success-primary,#16a34a);cursor:default}
.dshm-btn.ghost{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280)}
.dshm-btn.upd{background:var(--dsw-alias-state-warn-primary,#ea580c);color:#fff}
.dshm-btn.danger{background:transparent;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}
.dshm-btn.danger.armed{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}
.dshm-dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--dsw-alias-state-error-primary,#ef4444);margin-left:5px;vertical-align:2px}
.dshm-loading{display:flex;flex-direction:column;align-items:center;gap:12px;padding:48px;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:13px}
.dshm-spin{width:22px;height:22px;border:3px solid var(--dsw-alias-border-l1,#e5e7eb);border-top-color:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;animation:dshm-sp .8s linear infinite}
@keyframes dshm-sp{to{transform:rotate(360deg)}}
.dshm-progress{display:flex;align-items:center;gap:9px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;padding:8px 12px;font-size:12px;margin:10px 4px 0;color:var(--dsw-alias-label-secondary,#6b7280)}
.dshm-progress .dshm-spin{width:14px;height:14px;border-width:2px;flex-shrink:0}
.dshm-progress code{font-family:ui-monospace,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshm-toast{position:fixed;right:22px;bottom:22px;z-index:2000;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:13px 16px;box-shadow:0 12px 40px rgba(0,0,0,.18);display:flex;align-items:center;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328);pointer-events:auto;max-width:340px}
.dshm-empty{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:13px;padding:32px;text-align:center}
.dshm-err{color:var(--dsw-alias-state-error-primary,#dc2626);font-size:12px;margin:8px 0;white-space:pre-wrap;word-break:break-all}
.dshm-mask{position:fixed;inset:0;background:rgba(15,18,25,.4);display:flex;align-items:center;justify-content:center;z-index:1000}
.dshm-modal{width:min(400px,90%);background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:14px;padding:18px 20px;box-shadow:0 24px 70px rgba(0,0,0,.25)}
.dshm-modal h3{font-size:14px;margin:0 0 8px}
.dshm-modal p{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6;margin:4px 0}
.dshm-cmd{font-size:11px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:6px;padding:6px 9px;font-family:ui-monospace,Menlo,monospace;margin:8px 0;word-break:break-all}
.dshm-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dshm-irow{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;margin-bottom:8px}
.dshm-irow>.dshm-src,.dshm-irow>.dshm-owner,.dshm-irow>.dshm-btn{white-space:nowrap;flex-shrink:0}
.dshm-spec{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);font-family:ui-monospace,Menlo,monospace}
`

function injectStyles() {
  if (document.querySelector('style[data-plugin-css="dsh-market/market"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = "dshmarket"
  tag.dataset.pluginCss = 'dsh-market/market'
  tag.textContent = CSS
  document.head.appendChild(tag)
}


function avatarColor(name) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return 'hsl(' + (((hash % 360) + 360) % 360) + ' 55% 52%)'
}

function repoOf(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(url)
  return m ? m[1] : null
}

function readSession(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null') } catch { return null }
}

/** Heuristic: plugins that target a terminal surface rather than the web UI. */
function looksTerminal(plugin, lang) {
  const desc = (plugin.description && (plugin.description[lang] || plugin.description.en)) || ''
  return /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(plugin.name + ' ' + desc)
}

/** A registry plugin counts as installed when its package name, npm name, or GitHub spec appears in the profile dependencies. */
function isInstalled(plugin, installed) {
  if (installed[plugin.name] !== undefined) return true
  if (plugin.npm && installed[plugin.npm] !== undefined) return true
  const repo = repoOf(plugin.url)
  if (repo === null) return false
  const needle = ('github:' + repo).toLowerCase()
  return Object.values(installed).some(spec => String(spec).toLowerCase().includes(needle))
}

function MarketSection(props) {
  const t = props.t
  const localeSnap = React.useSyncExternalStore(
    cb => props.locale.subscribe(cb),
    () => props.locale.getSnapshot(),
  )
  const lang = String(localeSnap.active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(false)
  const [installed, setInstalled] = useState({})
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem('dshm-tab')
    if (saved !== null) sessionStorage.removeItem('dshm-tab')
    return saved || 'discover'
  })
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [confirming, setConfirming] = useState(null)
  const [busyUrl, setBusyUrl] = useState(null)
  const [doneUrls, setDoneUrls] = useState([])
  const [installError, setInstallError] = useState(null)
  const [updates, setUpdates] = useState({})
  const [updatingName, setUpdatingName] = useState(null)
  const [updatedNames, setUpdatedNames] = useState([])
  const [hotUrls, setHotUrls] = useState([])
  const [hotNames, setHotNames] = useState([])
  const [progressLine, setProgressLine] = useState(null)
  const [removeArmed, setRemoveArmed] = useState(null)
  const [removingName, setRemovingName] = useState(null)
  const [removedCount, setRemovedCount] = useState(0)
  const [envReady, setEnvReady] = useState(true)
  const [envFixing, setEnvFixing] = useState(false)
  const [envFailed, setEnvFailed] = useState(false)
  const [bootId, setBootId] = useState(null)
  const [showTop, setShowTop] = useState(false)
  const bodyRef = React.useRef(null)
  const [sort, setSort] = useState('hot')

  const refreshInstalled = useCallback((force) => {
    fetch('/dsh-market/installed', { cache: 'no-store' })
      .then(res => res.json())
      .then(body => setInstalled(body.installed || {}))
      .catch(() => {})
    fetch('/dsh-market/updates' + (force === true ? '?force=1' : ''), { cache: 'no-store' })
      .then(res => res.json())
      .then(body => setUpdates(body.updates || {}))
      .catch(() => {})
  }, [])

  useEffect(() => {
    injectStyles()
    fetch('/dsh-market/registry', { cache: 'no-store' })
      .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json() })
      .then(body => setData(body.registry))
      .catch(() => setLoadError(true))
    fetch('/dsh-market/status', { cache: 'no-store' })
      .then(res => res.json())
      .then(status => {
        setEnvReady(status.pnpm !== false)
        if (typeof status.boot === 'string') setBootId(status.boot)
      })
      .catch(() => {})
    refreshInstalled()
  }, [refreshInstalled])

  // Pending-restart flags survive tab switches and page reloads, scoped to
  // one host process: a different boot id means the restart happened and the
  // stale banner must not resurrect.
  useEffect(() => {
    if (bootId === null) return
    const saved = readSession('dshm-restart')
    if (saved === null) return
    if (saved.boot !== bootId) {
      sessionStorage.removeItem('dshm-restart')
      return
    }
    if (Array.isArray(saved.doneUrls) && saved.doneUrls.length > 0) setDoneUrls(saved.doneUrls)
    if (Array.isArray(saved.updated) && saved.updated.length > 0) setUpdatedNames(saved.updated)
    if (typeof saved.removed === 'number' && saved.removed > 0) setRemovedCount(saved.removed)
  }, [bootId])

  useEffect(() => {
    if (bootId === null) return
    if (doneUrls.length === 0 && updatedNames.length === 0 && removedCount === 0) return
    sessionStorage.setItem('dshm-restart', JSON.stringify({
      boot: bootId,
      doneUrls,
      updated: updatedNames,
      removed: removedCount,
    }))
  }, [bootId, doneUrls, updatedNames, removedCount])

  const fixEnv = useCallback(() => {
    setEnvFixing(true)
    setEnvFailed(false)
    fetch('/dsh-market/setup-pnpm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(res => res.json())
      .then(body => {
        if (body.ok) setEnvReady(true)
        else setEnvFailed(true)
      })
      .catch(() => setEnvFailed(true))
      .finally(() => setEnvFixing(false))
  }, [])

  // Recover an install whose HTTP response was lost (page navigated away or
  // the connection dropped): the pending marker survives in sessionStorage and
  // the poll below converges the button state from the host's ground truth.
  useEffect(() => {
    const pending = readSession('dshm-pending')
    if (pending !== null && typeof pending.url === 'string') setBusyUrl(pending.url)
  }, [])

  useEffect(() => {
    if (busyUrl === null && updatingName === null) {
      setProgressLine(null)
      return
    }
    const timer = setInterval(() => {
      fetch('/dsh-market/status', { cache: 'no-store' })
        .then(res => res.json())
        .then(status => {
          if (status.active) {
            setProgressLine((status.lastLine || '…') + '  (' + status.seconds + 's)')
          } else {
            setProgressLine(null)
            setInstalled(status.installed || {})
            const pending = readSession('dshm-pending')
            if (pending !== null && busyUrl !== null) {
              const nowInstalled = data !== null && data.plugins.some(p =>
                p.url === busyUrl && isInstalled(p, status.installed || {}))
              if (nowInstalled) {
                sessionStorage.removeItem('dshm-pending')
                setDoneUrls(urls => urls.includes(busyUrl) ? urls : urls.concat(busyUrl))
                setBusyUrl(null)
              }
            }
          }
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [busyUrl, updatingName, data])

  const plugins = useMemo(() => {
    if (data === null) return []
    const query = q.trim().toLowerCase()
    const list = data.plugins.filter(p => {
      if (cat !== 'all' && p.category !== cat) return false
      if (query === '') return true
      const desc = (p.description && (p.description[lang] || p.description.en)) || ''
      return p.name.toLowerCase().includes(query)
        || p.owner.toLowerCase().includes(query)
        || desc.toLowerCase().includes(query)
    })
    if (sort === 'hot') {
      return [...list].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))
    }
    if (sort === 'new') {
      return [...list].sort((a, b) => String(b.added).localeCompare(String(a.added)))
    }
    return list
  }, [data, q, cat, lang, sort])

  const doInstall = useCallback((plugin) => {
    setConfirming(null)
    setInstallError(null)
    setBusyUrl(plugin.url)
    sessionStorage.setItem('dshm-pending', JSON.stringify({ url: plugin.url }))
    fetch('/dsh-market/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: plugin.url }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        sessionStorage.removeItem('dshm-pending')
        if (status === 200 && body.ok) {
          sessionStorage.setItem('dshm-tab', 'installed')
          if (body.hot) {
            setHotUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
            setHotNames(names => names.includes(plugin.name) ? names : names.concat(plugin.name))
          } else {
            setDoneUrls(urls => urls.includes(plugin.url) ? urls : urls.concat(plugin.url))
          }
          refreshInstalled()
        } else {
          const text = v => typeof v === 'string' ? v : (v && typeof v.text === 'string') ? v.text : v == null ? '' : JSON.stringify(v)
          const detail = text(body.error) || text(body.stderr) || text(body.stdout) || ('exit ' + body.exitCode)
          setInstallError(t('installFail') + ': ' + plugin.name + ' — ' + detail.trim().slice(-600))
        }
      })
      .catch(error => {
        sessionStorage.removeItem('dshm-pending')
        setInstallError(t('installFail') + ': ' + String(error))
      })
      .finally(() => setBusyUrl(null))
  }, [refreshInstalled, t])

  const doUpdate = useCallback((name) => {
    setInstallError(null)
    setUpdatingName(name)
    fetch('/dsh-market/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          setUpdatedNames(names => names.concat(name))
          refreshInstalled()
        } else {
          const text = v => typeof v === 'string' ? v : (v && typeof v.text === 'string') ? v.text : v == null ? '' : JSON.stringify(v)
          const detail = text(body.error) || text(body.stderr) || text(body.stdout) || ('exit ' + body.exitCode)
          setInstallError(t('updateFail') + ': ' + name + ' — ' + detail.trim().slice(-600))
        }
      })
      .catch(error => setInstallError(t('updateFail') + ': ' + String(error)))
      .finally(() => setUpdatingName(null))
  }, [refreshInstalled, t])

  const doUninstall = useCallback((name) => {
    setRemoveArmed(null)
    setInstallError(null)
    setRemovingName(name)
    fetch('/dsh-market/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then(res => res.json().then(body => ({ status: res.status, body })))
      .then(({ status, body }) => {
        if (status === 200 && body.ok) {
          if (!body.hot) setRemovedCount(n => n + 1)
          refreshInstalled()
        } else {
          const text = v => typeof v === 'string' ? v : (v && typeof v.text === 'string') ? v.text : v == null ? '' : JSON.stringify(v)
          setInstallError((text(body.error) || text(body.stderr) || 'error').trim().slice(-600))
        }
      })
      .catch(error => setInstallError(String(error)))
      .finally(() => setRemovingName(null))
  }, [refreshInstalled])

  const pendingRestart = doneUrls.length + updatedNames.length + removedCount
  const hasUpdates = Object.keys(installed).some(
    name => !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable,
  )

  const categories = data === null ? [] : Object.keys(data.categories)

  return h('div', { className: 'dshm-root' },
    h('div', { className: 'dshm-head' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        h('h2', { className: 'dshm-title' }, t('nav')),
        (() => {
          const self = installed['dshmarket'] !== undefined ? 'dshmarket' : 'dsh-market'
          return updates[self] && updates[self].updateAvailable && !updatedNames.includes(self)
            && h('button', {
              className: 'dshm-btn upd',
              style: { fontSize: '11px', padding: '3px 10px' },
              disabled: updatingName !== null || busyUrl !== null,
              onClick: () => { setTab('installed'); doUpdate(self) },
            }, updatingName === self ? t('updating') : t('marketUpdate'))
        })()),
      h('div', { className: 'dshm-sub' },
        t('subtitle') + (data ? ' · ' + data.count : '') + ' · ',
        h('a', { className: 'dshm-src', href: '/dsh-market/logs', download: 'dsh-market-log.txt' }, t('exportLog'))),
      h('div', { className: 'dshm-search' },
        h('input', { placeholder: t('searchPh'), value: q, onChange: e => setQ(e.target.value) })),
      h('div', { className: 'dshm-tabs' },
        h('button', { className: 'dshm-tab' + (tab === 'discover' ? ' on' : ''), onClick: () => setTab('discover') }, t('tabDiscover')),
        h('button', { className: 'dshm-tab' + (tab === 'installed' ? ' on' : ''), onClick: () => { setTab('installed'); refreshInstalled(true) } },
          t('tabInstalled') + (Object.keys(installed).length > 0 ? ' (' + Object.keys(installed).length + ')' : ''),
          hasUpdates && h('span', { className: 'dshm-dot' }))),
      !envReady && h('div', { className: 'dshm-restart' },
        h('span', null, '🧩'),
        h('span', { className: 'dshm-grow' }, envFailed ? t('envFixFail') : t('envMissing')),
        !envFailed && h('button', {
          className: 'dshm-btn install' + (envFixing ? ' busy' : ''),
          disabled: envFixing,
          onClick: fixEnv,
        }, envFixing ? t('envFixing') : t('envFix'))),
      hotUrls.length > 0 && h('div', { className: 'dshm-restart' },
        h('span', null, '✨'),
        h('span', { className: 'dshm-grow' }, h('b', null, hotUrls.length), ' ', t('hotBanner')),
        h('button', {
          className: 'dshm-btn install',
          onClick: () => {
            sessionStorage.setItem('dshm-toast', JSON.stringify(hotNames))
            sessionStorage.setItem('dshm-tab', 'installed')
            location.reload()
          },
        }, t('refresh'))),
      pendingRestart > 0 && h('div', { className: 'dshm-restart' },
        h('span', null, '🔄'),
        h('span', { className: 'dshm-grow' }, h('b', null, pendingRestart), ' ', t('restartBanner')),
        h('span', { title: t('restartHint') }, 'ℹ️'))),
    installError !== null && h('div', { className: 'dshm-err' }, installError),
    h('div', {
      className: 'dshm-body',
      ref: bodyRef,
      onScroll: e => setShowTop(e.currentTarget.scrollTop > 400),
    },
      tab === 'discover'
        ? loadError
          ? h('div', { className: 'dshm-empty' }, t('loadFail'))
          : data === null
            ? h('div', { className: 'dshm-loading' }, h('span', { className: 'dshm-spin' }), t('loading'))
            : h(React.Fragment, null,
                h('div', { className: 'dshm-cats' },
                  h('button', { className: 'dshm-chip' + (cat === 'all' ? ' on' : ''), onClick: () => setCat('all') }, t('all')),
                  categories.map(id => h('button', {
                    key: id,
                    className: 'dshm-chip' + (cat === id ? ' on' : ''),
                    onClick: () => setCat(id),
                  }, (data.categories[id] && (data.categories[id][lang] || data.categories[id].en)) || id)),
                  h('div', { className: 'dshm-sort' },
                    ['hot', 'new'].map(key => h('button', {
                      key,
                      className: sort === key ? 'on' : '',
                      onClick: () => setSort(key),
                    }, t(key === 'hot' ? 'sortHot' : 'sortNew'))))),
                plugins.length === 0
                  ? h('div', { className: 'dshm-empty' }, t('empty'))
                  : h('div', { className: 'dshm-grid' }, plugins.map(p => {
                      const desc = (p.description && (p.description[lang] || p.description.en)) || ''
                      const done = doneUrls.includes(p.url) || hotUrls.includes(p.url)
                      const already = isInstalled(p, installed)
                      const busy = busyUrl === p.url
                      return h('div', { key: p.url, className: 'dshm-card' },
                        h('div', { className: 'dshm-row1' },
                          h('div', { className: 'dshm-av', style: { background: avatarColor(p.name) } },
                            p.name.replace(/^dsh[-_]/i, '').charAt(0).toUpperCase() || 'P'),
                          h('div', { style: { minWidth: 0 } },
                            h('div', { className: 'dshm-nm' }, p.name),
                            h('div', { className: 'dshm-owner' }, p.owner,
                              typeof p.stars === 'number' && h('span', { className: 'dshm-star' }, ' · ★ ' + p.stars))),
                          h('span', { className: 'dshm-grow' }),
                          h('a', { className: 'dshm-src', href: p.url, target: '_blank', rel: 'noreferrer', style: { alignSelf: 'flex-start', flexShrink: 0 } }, t('viewSource'))),
                        h('div', { className: 'dshm-desc' }, desc),
                        h('div', { className: 'dshm-foot' },
                          h('span', { className: 'dshm-cat' },
                            (data.categories[p.category] && (data.categories[p.category][lang] || data.categories[p.category].en)) || p.category),
                          h('span', { className: 'dshm-grow' }),
                          done
                            ? h('button', { className: 'dshm-btn done' }, t('installedBadge'))
                            : already
                              ? h('button', { className: 'dshm-btn done' }, t('alreadyInstalled'))
                              : busy
                                ? h('button', { className: 'dshm-btn install busy' }, t('installing'))
                                : h('button', {
                                    className: 'dshm-btn install',
                                    disabled: busyUrl !== null || !envReady,
                                    onClick: () => setConfirming(p),
                                  }, t('install'))),
                        busy && h('div', { className: 'dshm-progress', style: { margin: '6px 0 0' } },
                          h('span', { className: 'dshm-spin' }),
                          h('code', { className: 'dshm-grow' }, progressLine || t('progressHint'))))
                    })))
        : Object.keys(installed).length === 0
          ? h('div', { className: 'dshm-empty' }, t('installedEmpty'))
          : Object.entries(installed).map(([name, spec]) => {
              const entry = data === null ? undefined : data.plugins.find(p => p.name === name
                || (repoOf(p.url) !== null && String(spec).toLowerCase().includes(('github:' + repoOf(p.url)).toLowerCase())))
              const status = updates[name]
              const version = status && status.version ? 'v' + status.version : ''
              const specText = String(spec)
              const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText)
              const repoUrl = entry !== undefined ? entry.url : ghSpec !== null ? 'https://github.com/' + ghSpec[1] : null
              return h('div', { key: name, className: 'dshm-irow' },
                h('div', { style: { minWidth: 0 } },
                  h('div', { className: 'dshm-nm' }, name, version && h('span', { className: 'dshm-owner' }, ' ' + version)),
                  repoUrl !== null
                    ? h('a', { className: 'dshm-spec dshm-src', href: repoUrl, target: '_blank', rel: 'noreferrer', style: { display: 'inline-block' } }, specText)
                    : h('div', { className: 'dshm-spec' }, specText),
                  entry !== undefined && h('div', { className: 'dshm-desc', style: { minHeight: 0 } },
                    (entry.description && (entry.description[lang] || entry.description.en)) || ''),
                  updatingName === name && h('div', { className: 'dshm-progress', style: { margin: '6px 0 0' } },
                    h('span', { className: 'dshm-spin' }),
                    h('code', { className: 'dshm-grow' }, progressLine || t('progressHint')))),
                h('span', { className: 'dshm-grow' }),
                repoUrl !== null && h('a', { className: 'dshm-src', href: repoUrl + '#readme', target: '_blank', rel: 'noreferrer' }, t('readme')),
                updatedNames.includes(name)
                  ? h('button', { className: 'dshm-btn done' }, t('updated'))
                  : updatingName === name
                    ? h('button', { className: 'dshm-btn upd busy' }, t('updating'))
                    : status && status.updateAvailable
                      ? h('button', {
                          className: 'dshm-btn upd',
                          disabled: updatingName !== null,
                          onClick: () => doUpdate(name),
                        }, t('update'))
                      : status && status.kind === 'linked'
                        ? h('span', { className: 'dshm-owner' }, t('linkedDev'))
                        : h('span', { className: 'dshm-owner' }, t('upToDate')),
                name !== 'dsh-market' && name !== 'dshmarket' && (
                  removingName === name
                    ? h('button', { className: 'dshm-btn danger busy' }, t('uninstalling'))
                    : removeArmed === name
                      ? h('button', {
                          className: 'dshm-btn danger armed',
                          onClick: () => doUninstall(name),
                          onMouseLeave: () => setRemoveArmed(null),
                        }, t('confirmRemove'))
                      : h('button', {
                          className: 'dshm-btn danger',
                          disabled: removingName !== null || busyUrl !== null || updatingName !== null,
                          onClick: () => setRemoveArmed(name),
                        }, t('uninstall'))))
            })),
    showTop && h('button', {
      className: 'dshm-top',
      title: t('backTop'),
      onClick: () => { const el = bodyRef.current; if (el) el.scrollTo({ top: 0, behavior: 'smooth' }) },
    }, '↑'),
    confirming !== null && h('div', { className: 'dshm-mask', onClick: e => { if (e.target === e.currentTarget) setConfirming(null) } },
      h('div', { className: 'dshm-modal' },
        h('h3', null, t('confirmTitle') + ' ' + confirming.name + '?'),
        h('p', null, (confirming.description && (confirming.description[lang] || confirming.description.en)) || ''),
        h('div', { className: 'dshm-cmd' }, confirming.install),
        looksTerminal(confirming, lang) && h('p', { style: { color: 'var(--dsw-alias-state-warn-primary, #b45309)', fontWeight: 600 } },
          '🖥️ ' + t('terminalWarn') + ' ',
          h('a', { className: 'dshm-src', href: confirming.url + '#readme', target: '_blank', rel: 'noreferrer' }, t('readme'))),
        h('p', null, '⚠️ ' + t('confirmWarn')),
        h('div', { className: 'dshm-acts' },
          h('button', { className: 'dshm-btn ghost', onClick: () => setConfirming(null) }, t('cancel')),
          h('button', { className: 'dshm-btn install', onClick: () => doInstall(confirming) }, t('install'))))))
}

exports.name = 'dsh-market'
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-market: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'market',
    order: 40,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(MarketSection, { t, locale: ctx.locale })))

  // Post-reload confirmation: a floating "installed and live" card in the
  // shell overlay layer, shown once after the refresh that follows a hot
  // install, so the user lands back in their flow with visible proof.
  function InstallToast() {
    const [names, setNames] = useState(() => {
      const value = readSession('dshm-toast')
      sessionStorage.removeItem('dshm-toast')
      return Array.isArray(value) ? value : []
    })
    useEffect(() => {
      if (names.length === 0) return
      injectStyles()
      const timer = setTimeout(() => setNames([]), 10000)
      return () => clearTimeout(timer)
    }, [names])
    if (names.length === 0) return null
    return h('div', { className: 'dshm-toast' },
      h('span', null, '✨'),
      h('span', null, names.join(', ') + ' ' + t('toastReady')),
      h('button', { className: 'dshm-btn install', onClick: () => setNames([]) }, t('gotIt')))
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-market-toast',
    label: () => 'dsh-market',
  }, InstallToast))
}

return module.exports; } });
