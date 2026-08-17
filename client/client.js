window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {


		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		_deepseek_ai_dsh_client_ui_primitives = __toESM(_deepseek_ai_dsh_client_ui_primitives, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/** zh/en dictionaries for the Market settings section and install toast. */
		const zh = {
			nav: "插件市场",
			subtitle: "发现社区为 DeepSeek Harness 打造的能力",
			searchPh: "搜索插件，比如：通知、终端、记忆…",
			tabDiscover: "发现",
			tabInstalled: "已安装",
			all: "全部",
			install: "安装",
			installing: "安装中…",
			installedBadge: "✓ 已装好",
			alreadyInstalled: "✓ 已安装",
			restartBanner: "项变更完成，重启 DeepSeek Harness 后生效",
			uninstall: "卸载",
			confirmRemove: "确认卸载？",
			uninstalling: "卸载中…",
			uninstallConfirmDesc: "将从当前 profile 中移除该插件。",
			restartHint: "重启方式：关闭当前 dsh 进程后重新运行（例如 dsh web）",
			confirmTitle: "安装",
			confirmWarn: "插件是社区第三方代码。安装即表示你信任该来源；构建脚本默认被禁止执行。",
			cancel: "取消",
			empty: "没有匹配的插件",
			installedEmpty: "还没有装过社区插件，去「发现」页逛逛吧",
			loadFail: "插件目录加载失败，请稍后重试",
			installFail: "安装失败",
			viewSource: "源码",
			hotBanner: "个新插件已装好，刷新页面即可使用",
			refreshBanner: "项变更需刷新页面生效",
			refresh: "刷新页面",
			update: "更新",
			updating: "更新中…",
			updated: "✓ 已更新，重启后生效",
			cancelOp: "取消",
			cancelled: "已取消",
			busyWait: "已有操作正在进行，请等它结束（同一时间只执行一个安装/更新/卸载）",
			approveBuilds: "放行构建脚本并重试",
			buildsSkipped: "该插件需要运行构建脚本才能工作，出于安全默认被拦下。点击下方按钮为它放行并重装：",
			restartNow: "立即重启",
			dismiss: "知道了",
			dismissNotice: "关闭此提示",
			restarting: "正在重启…",
			restartFail: "重启失败",
			restartTimeout: "等待 DeepSeek Harness 启动超时",
			updateNow: "立即更新",
			updateFail: "更新失败",
			upToDate: "已是最新",
			linkedDev: "本地开发链接",
			exportLog: "导出日志",
			exportingLog: "导出中…",
			exportedLog: "日志已导出：dsh-market-log.txt，请把它附到 issue 里",
			exportLogFail: "日志导出失败",
			readme: "使用说明",
			terminalWarn: "这看起来是终端/命令行插件：装进网页版可能无效，甚至导致 DeepSeek Harness 无法启动。建议先看它的使用说明，按说明装进对应的 profile。",
			envMissing: "还差一个小组件才能安装插件",
			envFix: "自动装好",
			envFixing: "正在准备…",
			envFixFail: "自动准备没成功，请点\"导出日志\"把文件发给我们反馈",
			loading: "正在加载插件目录…",
			backTop: "回到顶部",
			confirm: "确认",
			cmdDetails: "安装命令",
			catsMore: "更多分类",
			catsLess: "收起",
			filter: "筛选",
			filterSort: "排序字段",
			filterDir: "排序方向",
			filterTime: "发布时间范围",
			sortStars: "Star 数",
			sortAdded: "发布时间",
			sortDesc: "降序",
			sortAsc: "升序",
			sortNewest: "最新",
			sortOldest: "最旧",
			timeAll: "全部时间",
			timeDay: "最近 1 天",
			timeWeek: "最近 7 天",
			timeMonth: "最近 30 天",
			timeQuarter: "最近 90 天",
			timeYear: "最近 1 年",
			published: "发布于",
			prevPage: "上一页",
			nextPage: "下一页",
			firstPage: "首页",
			lastPage: "末页",
			pageInfo: "第 {0} / {1} 页",
			perPage: "每页",
			marketUpdate: "市场有新版本，升级",
			updateAll: "全部更新",
			tabThemes: "主题",
			tabBackup: "备份与恢复",
			backupLocal: "本地文件",
			backupDownload: "导出备份",
			backupImport: "导入并预览",
			backupHint: "仅包含插件清单和 profile 配置，不包含 node_modules；恢复会按清单重新安装插件。",
			webdav: "WebDAV",
			webdavPreset: "服务商预设",
			webdavUrl: "备份文件 URL",
			webdavUser: "用户名（可选）",
			webdavPassword: "密码（可选）",
			webdavUpload: "上传备份",
			webdavRestore: "从 WebDAV 恢复",
			autoBackup: "每天自动备份（打开市场时）",
			webdavNote: "WebDAV 地址与用户名仅保存在当前浏览器；密码只存于服务端，每次会话需重新输入。",
			localOnly: "WebDAV 地址和凭证仅保存在当前浏览器。",
			credsWarning: "注意：备份包含配置与可能含密钥的文件（config.toml、.env 等）。下载件会原样导出，上传 WebDAV 前请确认目标可信。",
			gist: "GitHub Gist",
			gistToken: "GitHub token（仅本次会话内存，刷新后需重新输入；留空则使用服务端 DSH_GITHUB_TOKEN 或已登录的 gh CLI）",
			gistId: "Gist ID 或链接（导出留空则新建私有 Gist）",
			gistVerify: "验证连接",
			gistExport: "导出到 Gist…",
			gistImport: "从 Gist 导入",
			gistExportDone: "已导出到 Gist",
			gistVerifySource: "验证通过（Token 来源：{0}）",
			gistSrcToken: "手动输入",
			gistSrcEnv: "环境变量 DSH_GITHUB_TOKEN",
			gistSrcGh: "gh CLI",
			gistExportSelect: "选择要导出的插件",
			gistExportHint: "全部勾选 = 完整备份（含配置文件）；取消勾选 = 仅导出所选插件，可另行勾选“包含配置文件”。",
			gistSelectAll: "全选",
			gistSelectNone: "全不选",
			gistIncludeConfig: "包含配置文件（可能含密钥，请确认）",
			gistNoPlugins: "当前 profile 没有可导出的插件",
			gistSpecLocal: "本地",
			gistExportGo: "导出",
			gistCreated: "已导出：",
			gistErrTimeout: "GitHub 请求超时，请检查网络后重试",
			gistErrNetwork: "无法连接 GitHub，请检查网络或代理设置",
			gistErrAuth: "GitHub 认证失败：Token 无效、已过期，或 gh CLI 未登录",
			gistErrNotFound: "未找到该 Gist，请检查 ID 或链接",
			gistErrRateLimit: "GitHub 限流或 Token 权限不足",
			gistErrInvalid: "Gist 内容无效或备份格式不受支持",
			gistModeUpdate: "更新到输入框中的 Gist",
			gistModeCreate: "新建一个私有 Gist",
			gistErrNoId: "更新模式需要 Gist ID：请填写，或切换为“新建”",
			gistNote: "与本地导出（本机存档）不同，Gist 用于跨机器同步：导出到私有 Gist 后，可在其他电脑用同一账号导入复用。Token 仅保存在本次会话内存中，绝不写入浏览器存储；已登录 gh CLI 或设置 DSH_GITHUB_TOKEN 则无需输入。Gist 为私有，单文件上限 1 MB。",
			backupWorking: "处理中…",
			backupDone: "备份已上传",
			restoreDone: "恢复完成，请重启 DeepSeek Harness",
			restorePartial: "恢复已继续完成，但以下插件安装失败：",
			restoreConfirm: "恢复将覆盖当前 profile 配置并重新安装插件，确定继续吗？",
			restorePreviewDone: "备份已导入，请在“已安装”中确认后开始恢复",
			restoreMissing: "备份中有 {0} 个插件尚未安装",
			restoreStart: "开始恢复",
			notInstalled: "未安装",
			themeApply: "使用",
			themeActive: "使用中",
			themeDeactivate: "停用",
			themeEmpty: "目录里暂时还没有主题，敬请期待",
			progressHint: "首次安装需要下载与解析依赖，大插件可能要 1-3 分钟",
			toastReady: "已装好并已生效",
			toastTheme: "已启用。到 设置 → 插件市场 → 主题 可随时切换",
			gotIt: "知道了",
			stateLive: "已生效（热加载）",
			stateRestart: "已安装，重启后生效",
			stateInert: "已安装但未成为 profile 层",
			stateBroken: "安装完成但校验失败",
			stateDisabled: "已停用",
			phaseResolving: "解析依赖",
			phaseDownloading: "下载中",
			phaseLinking: "链接依赖",
			phaseBuilding: "运行构建脚本",
			cancelling: "正在取消…",
			packagesDone: "已处理 {0} 个包",
			updatedLive: "✓ 已更新，已生效",
			partialNote: "已取消，部分变更已写入",
			actWhy: "为什么未生效？",
			tabList: "列表",
			tabGroups: "分组",
			disabledState: "已停用",
			enable: "启用",
			disable: "停用",
			toggleFail: "切换失败",
			patchDisabled: "补丁停用",
			patchForced: "补丁强制启用",
			deprecatedBadge: "已废弃",
			deprecatedWarn: "该插件已被目录标记为废弃，不建议新用户安装。",
			viewReplacement: "查看替代品",
			installReplacement: "安装替代品",
			replacementHint: "目录建议改用",
			groupNew: "新建分组",
			groupNamePh: "分组名称",
			groupRename: "重命名",
			groupDelete: "删除分组",
			groupConfirmDelete: "确认删除？",
			ungrouped: "未分组",
			groupAssign: "分配",
			groupRemove: "移出",
			groupEmpty: "该组暂无成员",
			groupMixed: "部分启用",
			noGroups: "还没有分组，先新建一个吧",
			groupCreate: "创建",
			groupAdd: "加入插件",
			groupAddTheme: "加入主题",
			groupAddEmpty: "所有已安装插件都已在该组中",
			tabDiagnostics: "诊断",
			checkIssues: "发现问题",
			checkErrors: "错误",
			checkWarnings: "警告",
			checkLoading: "正在分析 profile…",
			checkLoadFail: "诊断加载失败：",
			checkProfile: "profile",
			checkErrorsEmpty: "没有错误",
			checkWarningsEmpty: "没有警告",
			checkBundles: "插件加载顺序（bundle）",
			checkBundlesEmpty: "未声明任何插件层",
			checkOfficial: "官方",
			checkCommunity: "社区",
			checkSource: "来源",
			checkEntries: "加载条目（loader id）",
			checkPatch: "patch 文件",
			checkDir: "目录",
			checkDuplicates: "重复的插件条目",
			checkDuplicatesEmpty: "没有重复的插件条目",
			checkHoisted: "顶层",
			checkPeerMismatches: "依赖版本不匹配",
			checkPeerEmpty: "没有依赖版本不匹配",
			checkPeerInfo: "另有 {0} 条信息（未确认问题）",
			checkPeerOverview: "{0} 不匹配 · {1} 条信息",
			checkRange: "声明范围",
			checkResolved: "实际版本",
			checkSatisfied: "满足",
			checkUnsatisfied: "不满足",
			checkUnknown: "未知",
			checkMultiVersion: "核心包多版本",
			checkMultiEmpty: "没有多版本核心包",
			checkOverrides: "覆盖关系",
			checkOverridesEmpty: "没有覆盖关系",
			checkOverridden: "覆盖了",
			checkOrphans: "无效的配置条目",
			checkOrphansEmpty: "没有无效配置条目",
			orphanInsertNotArray: "格式错误",
			orphanInsertTargetMissing: "目标不存在",
			orphanInsertTargetNotGroup: "目标不是分组",
			orphanIdRequired: "缺少标识",
			orphanPatchTargetMissing: "目标不存在",
			orphanNameMismatch: "名称不匹配",
			orphanReasonOther: "其他",
			diagExplain: "这是什么",
			diagExplainText: "这里检查插件之间可能互相冲突、依赖不匹配、加载顺序错误的问题。常用词：",
			diagTermBundle: "bundle = 一个插件包，会按顺序叠加加载",
			diagTermEntry: "加载条目 = 插件在运行组合里注册的每一项",
			diagTermPeer: "对等依赖 = 插件要求宿主环境提供的另一个包",
			diagTermShadow: "遮蔽 = 插件自带的旧版包盖住了宿主的新版",
			diagTermOrphan: "无效条目 = 配置里引用了不存在的东西",
			diagTermOrder: "加载顺序 = 插件被激活的先后，后加载者可能覆盖先加载者",
			orderSection: "排序",
			orderUp: "↑",
			orderDown: "↓",
			orderApply: "应用顺序",
			orderDrag: "拖拽排序",
			orderDragHint: "拖动 ⠿ 调整顺序，点「应用顺序」才保存",
			orderConflicts: "当前顺序的 before/after 冲突",
			orderApplied: "✓ 已应用，重启后生效",
			orderSuggestApply: "一键采用建议顺序",
			orderSuggestHint: "建议顺序（按 before/after 规则自动排序）：",
			orderAutoSort: "自动排序",
			orderAlreadyOptimal: "当前顺序已满足全部规则与插件依赖，无需调整",
			orderTrialFail: "静态组合校验未通过：{0}",
			orderDiffHint: "该顺序会改变组合：{0} 处覆盖、{1} 个无效条目、{2} 个重复条目",
			duplicateNames: "同名插件（仅信息展示，不视为冲突）",
			orderReset: "重置草稿",
			checkRefresh: "重新检查",
			aiFix: "AI 修复",
			aiFixHint: "把诊断问题交给新对话的 Agent 修复（复制到剪贴板，由你决定发送）",
			aiFixIntro: "请帮我修复 DeepSeek Harness 的插件问题（profile：{0}）。诊断发现如下：",
			aiFixScope: "你可以修改 profile 的 dsh.profile.bundles 顺序、停用/启用插件、调整 cordis.patch.yml。注意：官方 bundle 不可移动；动手前先说明计划。",
			aiFixConservative: "请保持保守：只修复上面列出的明确错误（启动失败/重复条目/确认不匹配的依赖）。警告和信息级问题（如未确认的依赖范围）仅在它们与明确错误相关时处理。不要做不必要的升级或重新排序；每项改动前说明理由并等待确认。",
			aiFixCopied: "已复制修复提示词，请粘贴到新对话后发送",
			aiFixFail: "无法访问剪贴板，请手动复制下面的诊断内容",
			catConflict: "冲突",
			catDeps: "依赖",
			catOrder: "顺序",
			/** Summary-strip tooltip for the order count (before/after rule conflicts). */
			checkOrderTip: "社区 bundle 加载顺序与插件声明的 before/after 规则冲突",
			diagOkAll: "一切正常：未发现冲突、依赖或顺序问题",
			marketNoToggle: "市场自身不能停用",
			hostDependencyWarning: "插件在 dependencies 中声明了已知的 DSH 共享宿主包，可能遮蔽宿主版本（仅依据清单，未确认运行时重复）：",
			hostDependencyMore: "另有 {0} 条，已省略"
		};
		const en = {
			nav: "Plugin Market",
			subtitle: "Discover community plugins for DeepSeek Harness",
			searchPh: "Search plugins: notify, terminal, memory…",
			tabDiscover: "Discover",
			tabInstalled: "Installed",
			all: "All",
			install: "Install",
			installing: "Installing…",
			installedBadge: "✓ Installed",
			alreadyInstalled: "✓ Installed",
			restartBanner: "change(s) done — restart DeepSeek Harness to apply",
			uninstall: "Uninstall",
			confirmRemove: "Confirm?",
			uninstalling: "Removing…",
			uninstallConfirmDesc: "This removes the plugin from the current profile.",
			restartHint: "To restart: stop the current dsh process and run it again (e.g. dsh web)",
			confirmTitle: "Install",
			confirmWarn: "Plugins are third-party community code. Installing means you trust this source; build scripts are blocked by default.",
			cancel: "Cancel",
			empty: "No plugins match",
			installedEmpty: "No community plugins yet — browse the Discover tab",
			loadFail: "Failed to load the plugin catalog, please retry later",
			installFail: "Install failed",
			viewSource: "Source",
			hotBanner: "new plugin(s) ready — refresh the page to use them",
			refreshBanner: "change(s) applied — refresh the page to see them",
			refresh: "Refresh",
			update: "Update",
			updating: "Updating…",
			updated: "✓ Updated — restart to apply",
			cancelOp: "Cancel",
			cancelled: "Cancelled",
			busyWait: "Another operation is already running — please wait for it to finish (one install/update/uninstall at a time)",
			approveBuilds: "Allow build scripts and retry",
			buildsSkipped: "This plugin needs its build scripts to run; they are blocked by default for safety. Click below to allow them and reinstall:",
			restartNow: "Restart now",
			dismiss: "Dismiss",
			dismissNotice: "Dismiss this notice",
			restarting: "Restarting…",
			restartFail: "Restart failed",
			restartTimeout: "Timed out waiting for DeepSeek Harness to start",
			updateNow: "Update now",
			updateFail: "Update failed",
			upToDate: "Up to date",
			linkedDev: "linked (dev)",
			exportLog: "Export log",
			exportingLog: "Exporting…",
			exportedLog: "Log exported: dsh-market-log.txt — please attach it to your issue",
			exportLogFail: "Log export failed",
			readme: "README",
			terminalWarn: "This looks like a terminal/CLI plugin: installing it into the web profile may do nothing, or even break DeepSeek Harness startup. Read its README and install it into the profile it targets.",
			envMissing: "One small component is needed before installing plugins",
			envFix: "Set up automatically",
			envFixing: "Setting up…",
			envFixFail: "Automatic setup failed — please use \"Export log\" and send us the file",
			loading: "Loading the catalog…",
			backTop: "Back to top",
			confirm: "Confirm",
			cmdDetails: "Install command",
			catsMore: "More",
			catsLess: "Less",
			filter: "Filter",
			filterSort: "Sort field",
			filterDir: "Order",
			filterTime: "Released within",
			sortStars: "Stars",
			sortAdded: "Release date",
			sortDesc: "Descending",
			sortAsc: "Ascending",
			sortNewest: "Newest",
			sortOldest: "Oldest",
			timeAll: "Any time",
			timeDay: "Last day",
			timeWeek: "Last 7 days",
			timeMonth: "Last 30 days",
			timeQuarter: "Last 90 days",
			timeYear: "Last year",
			published: "released",
			prevPage: "Previous",
			nextPage: "Next",
			firstPage: "First",
			lastPage: "Last",
			pageInfo: "Page {0} of {1}",
			perPage: "Per page",
			marketUpdate: "Market update available — upgrade",
			updateAll: "Update all",
			tabThemes: "Themes",
			tabBackup: "Backup & Restore",
			backupLocal: "Local file",
			backupDownload: "Export backup",
			backupImport: "Import and preview",
			backupHint: "Includes the plugin list and profile configuration, never node_modules. Restore reinstalls plugins from the list.",
			webdav: "WebDAV",
			webdavPreset: "Provider preset",
			webdavUrl: "Backup file URL",
			webdavUser: "Username (optional)",
			webdavPassword: "Password (optional)",
			webdavUpload: "Upload backup",
			webdavRestore: "Restore from WebDAV",
			autoBackup: "Back up daily (when the market opens)",
			webdavNote: "The WebDAV URL and username stay in this browser only; the password is kept server-side and must be re-entered each session.",
			localOnly: "The WebDAV URL and credentials stay in this browser only.",
			credsWarning: "Heads up: backups include profile configuration and files that may hold secrets (config.toml, .env, …). Local exports are unmodified, so only upload to a WebDAV target you trust.",
			gist: "GitHub Gist",
			gistToken: "GitHub token (session memory only — re-enter after refresh; leave empty to use server-side DSH_GITHUB_TOKEN or a logged-in gh CLI)",
			gistId: "Gist ID or URL (leave empty on export to create a new private Gist)",
			gistVerify: "Verify connection",
			gistExport: "Export to Gist…",
			gistImport: "Import from Gist",
			gistExportDone: "Exported to Gist",
			gistVerifySource: "Verified — token source: {0}",
			gistSrcToken: "manually entered",
			gistSrcEnv: "DSH_GITHUB_TOKEN env var",
			gistSrcGh: "gh CLI",
			gistExportSelect: "Select plugins to export",
			gistExportHint: "All checked = full backup (config included); unchecking any exports only the selected plugins, with an optional “include config” flag.",
			gistSelectAll: "Select all",
			gistSelectNone: "Select none",
			gistIncludeConfig: "Include config files (may contain secrets)",
			gistNoPlugins: "This profile has no plugins to export",
			gistSpecLocal: "local",
			gistExportGo: "Export",
			gistCreated: "Exported:",
			gistErrTimeout: "GitHub request timed out — check your network and retry",
			gistErrNetwork: "Cannot reach GitHub — check your network or proxy",
			gistErrAuth: "GitHub authentication failed: invalid/expired token, or gh CLI not logged in",
			gistErrNotFound: "Gist not found — check the ID or URL",
			gistErrRateLimit: "GitHub rate limit hit, or the token lacks the gist scope",
			gistErrInvalid: "Gist content is invalid or uses an unsupported backup format",
			gistModeUpdate: "Update the Gist in the field",
			gistModeCreate: "Create a new private Gist",
			gistErrNoId: "Update mode needs a Gist ID — fill it in, or switch to “Create”",
			gistNote: "Unlike local export (this-machine archive), Gist is for cross-machine sync: export to a private Gist, then import it on another computer with the same account to reuse your plugins. The token lives in this session's memory only and is never written to browser storage; a logged-in gh CLI or DSH_GITHUB_TOKEN skips entering it. Gists are private, 1 MB per file.",
			backupWorking: "Working…",
			backupDone: "Backup uploaded",
			restoreDone: "Restore complete — restart DeepSeek Harness",
			restorePartial: "Restore continued, but these plugins failed to install:",
			restoreConfirm: "Restore will overwrite this profile configuration and reinstall plugins. Continue?",
			restorePreviewDone: "Backup imported. Review Installed, then start restore.",
			restoreMissing: "{0} plugins from this backup are not installed",
			restoreStart: "Start restore",
			notInstalled: "Not installed",
			themeApply: "Use",
			themeActive: "Active",
			themeDeactivate: "Deactivate",
			themeEmpty: "No more theme plugins in the catalog yet — stay tuned",
			progressHint: "First installs download and resolve dependencies — large plugins can take 1-3 minutes",
			toastReady: "installed and live",
			toastTheme: "is now active. Switch any time in Settings → Plugin Market → Themes",
			gotIt: "Got it",
			stateLive: "Live (hot-loaded)",
			stateRestart: "Installed — restart to apply",
			stateInert: "Installed but not a profile-layer plugin",
			stateBroken: "Installed but failed validation",
			stateDisabled: "Disabled",
			phaseResolving: "Resolving dependencies",
			phaseDownloading: "Downloading",
			phaseLinking: "Linking",
			phaseBuilding: "Running build scripts",
			cancelling: "Cancelling…",
			packagesDone: "{0} packages processed",
			updatedLive: "✓ Updated — live",
			partialNote: "Cancelled — some changes were applied",
			actWhy: "Why not live?",
			tabList: "List",
			tabGroups: "Groups",
			disabledState: "Disabled",
			enable: "Enable",
			disable: "Disable",
			toggleFail: "Toggle failed",
			patchDisabled: "Patch-disabled",
			patchForced: "Patch-forced on",
			deprecatedBadge: "Deprecated",
			deprecatedWarn: "This plugin is marked as deprecated by the catalog; new users are advised against installing it.",
			viewReplacement: "View replacement",
			installReplacement: "Install replacement",
			replacementHint: "Catalog suggests",
			groupNew: "New group",
			groupNamePh: "Group name",
			groupRename: "Rename",
			groupDelete: "Delete group",
			groupConfirmDelete: "Delete group?",
			ungrouped: "Ungrouped",
			groupAssign: "Assign",
			groupRemove: "Remove",
			groupEmpty: "No members yet",
			groupMixed: "Partially enabled",
			noGroups: "No groups yet — create one",
			groupCreate: "Create",
			groupAdd: "Add plugin",
			groupAddTheme: "Add theme",
			groupAddEmpty: "Every installed plugin is already in this group",
			tabDiagnostics: "Diagnostics",
			checkIssues: "Issues found",
			checkErrors: "Errors",
			checkWarnings: "Warnings",
			checkLoading: "Analyzing the profile…",
			checkLoadFail: "Failed to load diagnostics: ",
			checkProfile: "profile",
			checkErrorsEmpty: "No errors",
			checkWarningsEmpty: "No warnings",
			checkBundles: "Plugin load order (bundles)",
			checkBundlesEmpty: "No plugin layers declared",
			checkOfficial: "official",
			checkCommunity: "community",
			checkSource: "source",
			checkEntries: "entries (loader ids)",
			checkPatch: "patch file",
			checkDir: "directory",
			checkDuplicates: "Duplicate plugin entries",
			checkDuplicatesEmpty: "No duplicate plugin entries",
			checkHoisted: "hoisted",
			checkPeerMismatches: "Dependency version mismatches",
			checkPeerEmpty: "No dependency version mismatches",
			checkPeerInfo: "{0} informational entries (unconfirmed)",
			checkPeerOverview: "{0} mismatch(es) · {1} informational",
			checkRange: "declared range",
			checkResolved: "resolved version",
			checkSatisfied: "satisfied",
			checkUnsatisfied: "not satisfied",
			checkUnknown: "unknown",
			checkMultiVersion: "Multi-version core packages",
			checkMultiEmpty: "No multi-version core packages",
			checkOverrides: "Overrides",
			checkOverridesEmpty: "No overrides",
			checkOverridden: "overrides",
			checkOrphans: "Invalid config entries",
			checkOrphansEmpty: "No invalid config entries",
			orphanInsertNotArray: "malformed",
			orphanInsertTargetMissing: "target not found",
			orphanInsertTargetNotGroup: "target is not a group",
			orphanIdRequired: "missing id",
			orphanPatchTargetMissing: "target not found",
			orphanNameMismatch: "name mismatch",
			orphanReasonOther: "other",
			diagExplain: "What is this",
			diagExplainText: "This page checks for plugins that conflict with each other, mismatched dependencies, or wrong load order. Terms used:",
			diagTermBundle: "bundle = one plugin package, applied in order",
			diagTermEntry: "entry = one item a plugin registers in the running composition",
			diagTermPeer: "peer dependency = another package a plugin requires from the host",
			diagTermShadow: "shadowing = a plugin’s old copy covers the host’s newer one",
			diagTermOrphan: "invalid entry = config references something that does not exist",
			diagTermOrder: "load order = the order plugins activate; the later one may override the earlier",
			orderSection: "Ordering",
			orderUp: "↑",
			orderDown: "↓",
			orderApply: "Apply order",
			orderDrag: "Drag to reorder",
			orderDragHint: "Drag ⠿ to reorder; clicking \"Apply order\" saves it",
			orderConflicts: "before/after conflicts in the current order",
			orderApplied: "✓ Applied — restart to apply",
			orderSuggestApply: "Apply suggested order",
			orderSuggestHint: "Suggested order (auto-sorted by before/after rules):",
			orderAutoSort: "Auto-sort",
			orderAlreadyOptimal: "Current order already satisfies every rule and plugin dependency — nothing to reorder",
			orderTrialFail: "Static composition validation failed: {0}",
			orderDiffHint: "This order would change the composition: {0} override(s), {1} orphan(s), {2} duplicate(s)",
			duplicateNames: "Same-name plugins (informational only, not a conflict)",
			orderReset: "Reset draft",
			checkRefresh: "Re-check",
			aiFix: "AI fix",
			aiFixHint: "Hand the diagnostics to a new Agent session (copied to the clipboard; you decide whether to send)",
			aiFixIntro: "Please help me fix the plugin issues of DeepSeek Harness (profile: {0}). Diagnostics found:",
			aiFixScope: "You may reorder dsh.profile.bundles, disable/enable plugins, or adjust cordis.patch.yml. Note: official bundles are fixed; state your plan before changing anything.",
			aiFixConservative: "Be conservative: only fix the clear errors listed above (boot failures / duplicate entries / confirmed dependency mismatches). Treat warnings and informational entries (e.g. unconfirmed peer ranges) only when they relate to a clear error. Do not perform unnecessary upgrades or reordering; explain each change and wait for confirmation.",
			aiFixCopied: "Fix prompt copied — paste it into a new conversation and send when ready",
			aiFixFail: "Clipboard unavailable — copy the diagnostics below manually",
			catConflict: "Conflicts",
			catDeps: "Dependencies",
			catOrder: "Order",
			/** Summary-strip tooltip for the order count (before/after rule conflicts). */
			checkOrderTip: "community bundle load order conflicts with declared before/after rules",
			diagOkAll: "All good: no conflict, dependency or ordering issues found",
			marketNoToggle: "The market itself cannot be disabled",
			hostDependencyWarning: "A plugin lists known shared DSH host packages in dependencies. This may shadow the host version; the check is manifest-only and does not confirm a duplicate runtime instance:",
			hostDependencyMore: "{0} more finding(s) omitted"
		};
		//#endregion
		//#region src/client/market-data.ts
		function groupSwitchState(members, disabled) {
			const list = members ?? [];
			if (list.length === 0) return "empty";
			let anyOn = false;
			let anyOff = false;
			for (const member of list) if (disabled.has(member)) anyOff = true;
			else anyOn = true;
			return anyOn && anyOff ? "mixed" : anyOff ? "off" : "on";
		}
		function avatarColor(name) {
			let hash = 0;
			for (let i = 0; i < name.length; i++) hash = hash * 31 + name.charCodeAt(i) | 0;
			return "hsl(" + (hash % 360 + 360) % 360 + " 55% 52%)";
		}
		function readSession(key) {
			try {
				return JSON.parse(sessionStorage.getItem(key) || "null");
			} catch {
				return null;
			}
		}
		/** Heuristic: plugins that target a terminal surface rather than the web UI. */
		function looksTerminal(plugin, lang) {
			const desc = plugin.description && (plugin.description[lang] || plugin.description.en) || "";
			return /\b(tui|cli|tty|terminal)\b|终端|命令行/i.test(plugin.name + " " + desc);
		}
		/** Days per TimeRange (`all` has no cutoff and is handled by the caller). */
		const TIME_RANGE_DAYS = {
			day: 1,
			week: 7,
			month: 30,
			quarter: 90,
			year: 365
		};
		/** True when `added` is a date within the last `days` days (inclusive). */
		function withinDays(added, days) {
			if (added === void 0 || added === "") return false;
			const time = Date.parse(added);
			if (Number.isNaN(time)) return false;
			const age = Date.now() - time;
			return age >= 0 && age <= days * 864e5;
		}
		/**
		* The discover list: category filter, then the published-within window, then
		* search across name / owner / localized description, then the selected sort.
		* Pure — the section renders exactly this.
		*/
		function visiblePlugins(plugins, options) {
			const query = options.query.trim().toLowerCase();
			const list = plugins.filter((p) => {
				if (options.category !== "all" && p.category !== options.category) return false;
				if (options.sinceDays !== void 0 && !withinDays(p.added, options.sinceDays)) return false;
				if (query === "") return true;
				const desc = p.description && (p.description[options.lang] || p.description.en) || "";
				return p.name.toLowerCase().includes(query) || p.owner.toLowerCase().includes(query) || desc.toLowerCase().includes(query);
			});
			if (options.sort === "stars-desc") return [...list].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));
			if (options.sort === "stars-asc") return [...list].sort((a, b) => (a.stars ?? -1) - (b.stars ?? -1));
			if (options.sort === "added-desc") return [...list].sort((a, b) => String(b.added).localeCompare(String(a.added)));
			if (options.sort === "added-asc") return [...list].sort((a, b) => String(a.added).localeCompare(String(b.added)));
			return list;
		}
		/** The themes tab listing: theme category only, most-starred first. */
		function themePlugins(plugins) {
			return plugins.filter((p) => p.category === "theme").sort((a, b) => (b.stars || 0) - (a.stars || 0));
		}
		/**
		* Category chip order: collapsed with an active non-'all' chip, the active
		* one moves to the front so it stays visible inside the two-row clip.
		*/
		function orderedCategories(categories, active, open) {
			return open || active === "all" ? categories : [active, ...categories.filter((id) => id !== active)];
		}
		/**
		* Page-number list for the discover pager. With few pages it is simply
		* 1..total; with many it windows around the current page and inserts '…'
		* so a 400-plugin catalog stays a compact `1 … 4 5 6 … 17` instead of a
		* long row of numbered buttons. Always begins with 1 and ends with total.
		*/
		function pageItems(current, total) {
			if (total <= 7) {
				const all = [];
				for (let i = 1; i <= total; i++) all.push(i);
				return all;
			}
			const items = [1];
			let start = Math.max(2, current - 1);
			let end = Math.min(total - 1, current + 1);
			if (current <= 4) end = 5;
			if (current >= total - 3) start = total - 4;
			if (start > 2) items.push("…");
			for (let i = start; i <= end; i++) items.push(i);
			if (end < total - 1) items.push("…");
			items.push(total);
			return items;
		}
		/**
		* Unified installed-state matching (#15): both sides collapse to lowercase
		* identity sets — the registry entry contributes its bare name, npm name and
		* owner/repo; the dependency contributes its key and the repo inside its
		* spec — and any exact intersection counts. Exact equality, not substrings,
		* so prefix-related repo names cannot cross-match.
		*/
		function entryIdentities(plugin) {
			const ids = /* @__PURE__ */ new Set([plugin.name.toLowerCase()]);
			if (plugin.npm) ids.add(plugin.npm.toLowerCase());
			const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url);
			if (m !== null) ids.add(m[2] !== void 0 ? `${m[1].toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1].toLowerCase());
			return ids;
		}
		function depIdentities(name, spec) {
			const ids = /* @__PURE__ */ new Set([name.toLowerCase()]);
			const scoped = /^@([^/]+)\/(.+)$/.exec(name);
			if (scoped !== null) ids.add(`${scoped[1].toLowerCase()}/${scoped[2].toLowerCase()}`);
			const match = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec);
			if (match !== null) {
				ids.add(match[1].toLowerCase());
				if (match[2] !== void 0) ids.add(`${match[1].toLowerCase()}#path:/${match[2].toLowerCase()}`);
			}
			return ids;
		}
		/**
		* Repo identities stated by the dependency SPEC itself (github: installs) —
		* hard evidence of where the package came from, unlike the name-derived
		* mirror in depIdentities, which is only a matching aid.
		*/
		function depSpecRepoIds(spec) {
			const ids = /* @__PURE__ */ new Set();
			const m = /github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#path:\/([A-Za-z0-9_./-]+))?/i.exec(spec);
			if (m !== null) {
				ids.add(m[1].toLowerCase());
				if (m[2] !== void 0) ids.add(`${m[1].toLowerCase()}#path:/${m[2].toLowerCase()}`);
			}
			return ids;
		}
		/** Repo identity of a registry entry's source url (repo or repo#path form). */
		function entryRepoIds(plugin) {
			const ids = /* @__PURE__ */ new Set();
			const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url);
			if (m !== null) ids.add(m[2] !== void 0 ? `${m[1].toLowerCase()}#path:/${m[2].toLowerCase()}` : m[1].toLowerCase());
			return ids;
		}
		/**
		* The curated registry lists distinct plugins sharing one name — twelve
		* name-groups at the time of #66 (both dsh-usage-stats, four dsh-memory…).
		* A name coincidence must not survive contradicting repo evidence: when the
		* dependency's spec pins a github repo AND the entry states one, the repos
		* decide — the loose name/npm identities only apply when at least one side
		* carries no repo evidence (npm installs, non-github entries).
		*/
		function sameSourceConflict(plugin, spec) {
			const entry = entryRepoIds(plugin);
			const dep = depSpecRepoIds(spec);
			if (entry.size === 0 || dep.size === 0) return false;
			for (const id of dep) if (entry.has(id)) return false;
			return true;
		}
		/** The installed dependency name a registry entry corresponds to, or null. */
		function matchInstalledName(plugin, installed) {
			const ids = entryIdentities(plugin);
			for (const [name, spec] of Object.entries(installed)) {
				if (sameSourceConflict(plugin, String(spec))) continue;
				for (const id of depIdentities(name, String(spec))) if (ids.has(id)) return name;
			}
			return null;
		}
		/** The registry entry an installed dependency corresponds to, or undefined. */
		function entryForDep(plugins, name, spec) {
			const ids = depIdentities(name, String(spec));
			return plugins.find((plugin) => {
				if (sameSourceConflict(plugin, String(spec))) return false;
				for (const id of entryIdentities(plugin)) if (ids.has(id)) return true;
				return false;
			});
		}
		function isInstalled(plugin, installed) {
			return matchInstalledName(plugin, installed) !== null;
		}
		/**
		* The header brand mark now lives in MarketSection.tsx as an inline SVG
		* (official-style monochrome glyph, fill="currentColor") so it follows the
		* active theme; the colored assets/logo.svg tile is no longer inlined here.
		*/
		/** Four representative colors for a theme card's preview strip. */
		function themeSwatch(def) {
			const tk = def.tokens || {};
			const pick = (names) => {
				for (const n of names) if (tk[n]) return tk[n];
				return null;
			};
			const dark = def.colorScheme === "dark";
			return [
				pick(["--dsw-alias-bg-base", "--dsw-alias-bg-layer-1"]) || (dark ? "#0f1115" : "#ffffff"),
				pick(["--dsw-alias-bg-layer-2", "--dsw-alias-bg-overlay"]) || (dark ? "#1a1d23" : "#f3f4f6"),
				pick(["--dsw-alias-brand-primary"]) || "#4f6ef7",
				pick(["--dsw-alias-label-primary"]) || (dark ? "#e5e7eb" : "#1f2328")
			];
		}
		/**
		* Image hosts screenshots may load from (#61) — GitHub's own hosting only.
		* Any other host is dropped BEFORE an <img> is created: a screenshot URL is
		* a request carrying the user's IP, so registry data and README content are
		* both treated as untrusted here, matching the upstream build gate.
		*/
		const SCREENSHOT_HOSTS = /* @__PURE__ */ new Set([
			"raw.githubusercontent.com",
			"user-images.githubusercontent.com",
			"camo.githubusercontent.com",
			"github.com"
		]);
		const MAX_SCREENSHOTS = 6;
		/** Keep only https URLs on allowlisted image hosts; SVG dropped (logos/badges). */
		function safeScreenshots(urls) {
			if (!Array.isArray(urls)) return [];
			const safe = [];
			for (const value of urls) {
				if (typeof value !== "string") continue;
				let parsed = null;
				try {
					parsed = new URL(value);
				} catch {
					continue;
				}
				if (parsed.protocol !== "https:" || !SCREENSHOT_HOSTS.has(parsed.hostname)) continue;
				if (/\.svg$/i.test(parsed.pathname)) continue;
				if (!safe.includes(value)) safe.push(value);
				if (safe.length >= MAX_SCREENSHOTS) break;
			}
			return safe;
		}
		/**
		* Image URLs extracted from a repo README, in document order — the fallback
		* when an entry has no curated screenshots (#61). Markdown and <img> forms;
		* relative paths resolve against the README's directory on
		* raw.githubusercontent.com; badges fall out naturally (shields.io etc. are
		* not allowlisted) and SVG is skipped as logo/badge noise.
		*/
		function extractReadmeImages(markdown, owner, repo, subpath) {
			const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${subpath === null ? "" : subpath + "/"}`;
			const found = [];
			const push = (raw) => {
				const src = raw.trim().replace(/^<|>$/g, "");
				if (src === "" || src.startsWith("data:")) return;
				let absolute;
				if (/^https?:\/\//i.test(src)) absolute = src;
				else if (src.startsWith("/")) absolute = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD${src}`;
				else try {
					absolute = new URL(src, base).href;
				} catch {
					return;
				}
				found.push(absolute);
			};
			for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|<img[^>]*\ssrc=["']([^"']+)["']/gi)) push(m[1] ?? m[2]);
			return safeScreenshots(found);
		}
		const readmeShotsCache = /* @__PURE__ */ new Map();
		/**
		* Screenshots for a plugin: the registry's curated list when present,
		* otherwise lazily extracted from the repo README. Only ever called AFTER
		* the user opens the detail dialog — browsing the list must make zero
		* external requests. Failures resolve to [] (silent degradation).
		*/
		function pluginScreenshots(plugin) {
			const curated = safeScreenshots(plugin.screenshots);
			if (curated.length > 0) return Promise.resolve(curated);
			const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(plugin.url);
			if (m === null) return Promise.resolve([]);
			const [, owner, repo, subpath = null] = m;
			const cacheKey = plugin.url;
			const cached = readmeShotsCache.get(cacheKey);
			if (cached !== void 0) return cached;
			const fetchReadme = async (path) => {
				try {
					const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path === null ? "" : path + "/"}README.md`);
					return res.ok ? await res.text() : null;
				} catch {
					return null;
				}
			};
			const task = (async () => {
				const sub = subpath === null ? null : await fetchReadme(subpath);
				if (sub !== null) return extractReadmeImages(sub, owner, repo, subpath);
				const root = await fetchReadme(null);
				return root === null ? [] : extractReadmeImages(root, owner, repo, null);
			})().catch(() => []);
			readmeShotsCache.set(cacheKey, task);
			return task;
		}
		//#endregion
		//#region src/client/InstallToast.tsx
		/**
		* Post-reload confirmation via the official Toast primitive: shown once after
		* the refresh that follows a hot install or theme switch, so the user lands
		* back in their flow with visible proof.
		*/
		function InstallToast(props) {
			const t = props.t;
			const [mode] = (0, react.useState)(() => {
				const value = sessionStorage.getItem("dshm-toast-mode");
				sessionStorage.removeItem("dshm-toast-mode");
				return value;
			});
			const [names, setNames] = (0, react.useState)(() => {
				const value = readSession("dshm-toast");
				sessionStorage.removeItem("dshm-toast");
				return Array.isArray(value) ? value : [];
			});
			if (names.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: names.join(", ") + " " + t(mode === "theme" ? "toastTheme" : "toastReady"),
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, { size: 14 }),
				onDone: () => setNames([])
			});
		}
		//#endregion
		//#region \0dsh-css:src/client/Market.module.css.mjs
		const css = ".SOz1_a_root{min-width:0;height:100%;color:var(--dsw-alias-label-primary,#1f2328);flex-direction:column;display:flex;position:relative}.SOz1_a_head{flex-direction:column;gap:12px;padding:4px 4px 12px;display:flex}.SOz1_a_title{margin:0;font-size:16px;font-weight:500;line-height:24px}.SOz1_a_sub{color:var(--dsw-alias-label-tertiary,#8b93a1);align-items:center;gap:8px;margin:0;font-size:14px;line-height:22px;display:flex}.SOz1_a_tabs{border-bottom:1px solid var(--dsw-alias-border-l2,#e5e7eb);align-items:flex-end;gap:2px;display:flex}.SOz1_a_tab{font:inherit;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-bottom:2px solid #0000;padding:7px 12px;font-size:13px}.SOz1_a_tab.SOz1_a_on{color:var(--dsw-alias-brand-primary,#4f6ef7);border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}.SOz1_a_banner{background:var(--dsw-alias-bg-layer-2,#fdf3e3);border:1px solid var(--dsw-alias-border-l2,#f3e3c3);border-radius:8px;align-items:center;gap:8px;margin:0;padding:8px 12px;font-size:12px;display:flex}.SOz1_a_bannerIcon{color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0}.SOz1_a_bannerHint{color:var(--dsw-alias-label-tertiary,#8b93a1);cursor:help;display:inline-flex}.SOz1_a_body{flex:1;padding:12px 4px 24px;overflow-x:hidden;overflow-y:auto}.SOz1_a_cats{z-index:5;background:var(--dsw-alias-bg-layer-2,#f7f8fa);margin:-12px -4px 2px;padding:12px 4px 4px;position:sticky;top:-13px}.SOz1_a_catsRow{align-items:flex-start;gap:8px;display:flex;position:relative}.SOz1_a_star{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}.SOz1_a_top{z-index:20;display:inline-flex;position:absolute;bottom:18px;right:18px}.SOz1_a_topBtn{border-radius:99px;width:38px;height:38px;padding:0}.SOz1_a_tag{border:1px solid var(--dsw-alias-border-l3,#d9dde3);color:var(--dsw-alias-label-secondary,#6b7280);border-radius:4px;flex-shrink:0;padding:1px 6px;font-size:11px;line-height:16px}.SOz1_a_okState{color:var(--dsw-alias-state-success-primary,#16a34a);white-space:nowrap;font-size:12px;font-weight:600}.SOz1_a_catsWrap{flex-wrap:wrap;flex:1;align-items:center;gap:6px;min-width:0;display:flex}.SOz1_a_catsCollapsed{max-height:62px;overflow:hidden}.SOz1_a_catsToggle.SOz1_a_catsToggle{height:26px;min-height:26px;color:var(--dsw-alias-label-secondary,#6b7280);padding:0 6px}.SOz1_a_shots{-webkit-overflow-scrolling:touch;scrollbar-width:thin;gap:8px;margin:0 0 8px;padding:2px 0 6px;display:flex;overflow-x:auto}.SOz1_a_shot{object-fit:cover;border:1px solid var(--dsw-alias-border-default,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:8px;flex:none;max-width:260px;height:150px}.SOz1_a_cmd{background:var(--dsw-alias-bg-layer-2,#f3f4f6);word-break:break-all;border-radius:6px;margin:8px 0 0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:18px}.SOz1_a_warnLine{color:var(--dsw-alias-state-warn-primary,#b45309);align-items:center;gap:4px;margin:0;font-size:12px;font-weight:600;line-height:18px;display:flex}.SOz1_a_modalNote{color:var(--dsw-alias-label-tertiary,#8b93a1);align-items:center;gap:4px;margin:12px 0 0;font-size:12px;line-height:18px;display:flex}.SOz1_a_grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;display:grid}.SOz1_a_swatches{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;gap:0;height:34px;display:flex;overflow:hidden}.SOz1_a_themesGrid{margin-bottom:12px}.SOz1_a_swatches i{flex:1}.SOz1_a_card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.SOz1_a_row1{align-items:center;gap:10px;min-width:0;display:flex}.SOz1_a_srcBtn{flex-shrink:0;align-self:flex-start}.SOz1_a_av{color:#fff;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:8px;flex-shrink:0;place-items:center;width:32px;height:32px;font-size:14px;font-weight:700;display:grid}.SOz1_a_nm{text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px;overflow:hidden}.SOz1_a_owner{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}.SOz1_a_desc{color:var(--dsw-alias-label-tertiary,#8b93a1);min-height:36px;margin:0;font-size:12px;line-height:18px}.SOz1_a_foot{align-items:center;gap:8px;margin-top:auto;display:flex}.SOz1_a_grow{flex:1}.SOz1_a_titleRow{align-items:center;gap:10px;display:flex}.SOz1_a_descTight{min-height:0}.SOz1_a_src{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;text-decoration:none}.SOz1_a_src:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_dot{vertical-align:2px;margin-left:5px}.SOz1_a_act{flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;font-size:11px;display:flex}.SOz1_a_actLive{color:var(--dsw-alias-state-success-primary,#16a34a);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actWarn{color:var(--dsw-alias-state-warn-primary,#b45309);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actBroken{color:var(--dsw-alias-state-error-primary,#dc2626);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actWhy{color:var(--dsw-alias-label-secondary,#6b7280);margin-top:2px}.SOz1_a_loading{color:var(--dsw-alias-label-secondary,#9ca3af);flex-direction:column;align-items:center;gap:12px;padding:48px;font-size:13px;display:flex}.SOz1_a_spin{color:var(--dsw-alias-brand-primary,#4f6ef7);flex-shrink:0;animation:.8s linear infinite SOz1_a_sp;display:inline-flex}@keyframes SOz1_a_sp{to{transform:rotate(360deg)}}.SOz1_a_progress{background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);color:var(--dsw-alias-label-secondary,#6b7280);border-radius:8px;flex-wrap:wrap;align-items:center;gap:9px;margin:0;padding:8px 12px;font-size:12px;display:flex}.SOz1_a_bar{background:var(--dsw-alias-border-l1,#e5e7eb);border-radius:99px;width:100%;height:4px;overflow:hidden}.SOz1_a_barFill{background:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;height:100%;transition:width .6s}.SOz1_a_barWave{width:30%;animation:1.2s ease-in-out infinite SOz1_a_dshmSlide}@keyframes SOz1_a_dshmSlide{0%{margin-left:-30%}to{margin-left:100%}}.SOz1_a_irow .SOz1_a_progress{margin-top:8px}.SOz1_a_progress code{text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11px;overflow:hidden}.SOz1_a_empty{color:var(--dsw-alias-label-secondary,#9ca3af);text-align:center;padding:32px;font-size:13px}.SOz1_a_err{color:var(--dsw-alias-state-error-primary,#dc2626);white-space:pre-wrap;word-break:break-all;margin:8px 0;font-size:12px}.SOz1_a_irow{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;align-items:center;gap:10px;margin-bottom:8px;padding:12px 14px;display:flex}.SOz1_a_irowMissing{filter:grayscale();opacity:.5}.SOz1_a_irow>.SOz1_a_src,.SOz1_a_irow>.SOz1_a_owner,.SOz1_a_irow button{white-space:nowrap;flex-shrink:0}.SOz1_a_tabSearchRow{padding:0 4px 10px;display:flex}.SOz1_a_tabSearch{width:260px}.SOz1_a_spec{color:var(--dsw-alias-label-secondary,#9ca3af);overflow-wrap:anywhere;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:11px}.SOz1_a_specTag{white-space:nowrap;border-radius:4px;flex-shrink:0;align-items:center;height:16px;padding:0 5px;font-size:10px;font-weight:600;display:inline-flex}.SOz1_a_specTagGit{color:#0b7285;background:#12a3c41f}.SOz1_a_specTagFile{color:#b07d1b;background:#f0b42924}.SOz1_a_backupCheckList .SOz1_a_grow{white-space:nowrap;text-overflow:ellipsis;flex:70%;min-width:0;overflow:hidden}.SOz1_a_backupCheckList .SOz1_a_spec{text-align:right;white-space:nowrap;text-overflow:ellipsis;flex:0 30%;max-width:30%;overflow:hidden}.SOz1_a_staleAction{margin-top:8px}.SOz1_a_pct{color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0;font-size:11px;font-weight:600}.SOz1_a_pager{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:16px 0 4px;display:flex}.SOz1_a_pagerPages{flex-wrap:wrap;flex:1;justify-content:center;align-items:center;gap:6px;min-width:0;display:flex}.SOz1_a_pageEllipsis{color:var(--dsw-alias-label-secondary,#9ca3af);padding:0 2px;font-size:12px}.SOz1_a_pageInfo{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;font-size:12px}.SOz1_a_depBadge{border:1px solid var(--dsw-alias-state-warn-primary,#b45309);color:var(--dsw-alias-state-warn-primary,#b45309);white-space:nowrap;border-radius:4px;flex-shrink:0;margin-left:6px;padding:1px 6px;font-size:11px;font-weight:600;line-height:16px}.SOz1_a_deprecate{color:var(--dsw-alias-state-warn-primary,#b45309);background:var(--dsw-alias-bg-layer-2,#fdf3e3);border:1px solid var(--dsw-alias-border-l2,#f3e3c3);border-radius:8px;margin:0;padding:8px 10px;font-size:12px;line-height:18px}.SOz1_a_deprecate a{color:var(--dsw-alias-state-warn-primary,#b45309);text-decoration:underline}.SOz1_a_deprecate .SOz1_a_src{margin-left:8px}.SOz1_a_depLine{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.SOz1_a_switch{border:1px solid var(--dsw-alias-border-l2,#d9dde3);background:var(--dsw-alias-bg-layer-2,#e5e7eb);cursor:pointer;border-radius:99px;flex-shrink:0;width:38px;height:22px;padding:0;transition:background .15s,border-color .15s;position:relative}.SOz1_a_switchOn{background:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a)}.SOz1_a_switchMixed{background:var(--dsw-alias-state-warn-primary,#b45309);border-color:var(--dsw-alias-state-warn-primary,#b45309)}.SOz1_a_switchKnob{background:#fff;border-radius:99px;width:16px;height:16px;transition:left .15s;position:absolute;top:2px;left:2px;box-shadow:0 1px 2px #00000040}.SOz1_a_switchOn .SOz1_a_switchKnob,.SOz1_a_switchMixed .SOz1_a_switchKnob{left:18px}.SOz1_a_switch:disabled{opacity:.5;cursor:default}.SOz1_a_viewBar{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;align-items:center;gap:2px;width:fit-content;margin-bottom:12px;padding:2px;display:flex}.SOz1_a_viewBtn{font:inherit;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px}.SOz1_a_viewBtn:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_viewOn{background:var(--dsw-alias-bg-layer-2,#eef0f4);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600}.SOz1_a_groupRow{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;margin-bottom:10px;padding:12px 14px}.SOz1_a_groupHead{align-items:center;gap:10px;min-width:0;display:flex}.SOz1_a_groupName{text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:20px;overflow:hidden}.SOz1_a_groupActions{flex-shrink:0;align-items:center;gap:6px;display:flex}.SOz1_a_groupMembers{flex-direction:column;gap:6px;margin-top:10px;display:flex}.SOz1_a_groupMember{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-radius:8px;align-items:center;gap:8px;padding:6px 8px;font-size:12px;line-height:18px;display:flex}.SOz1_a_groupMember .SOz1_a_nm{flex:1;min-width:0;font-size:12px}.SOz1_a_groupAddPanel{border-top:1px dashed var(--dsw-alias-border-l2,#e5e7eb);flex-direction:column;gap:6px;margin-top:10px;padding-top:10px;display:flex}.SOz1_a_groupCreate{align-items:center;gap:8px;margin-bottom:10px;display:flex}.SOz1_a_inlineInput{flex:1;min-width:120px}.SOz1_a_assignRow{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.SOz1_a_assignSelect{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;border-radius:6px;padding:3px 6px;font-size:12px;line-height:18px}.SOz1_a_groupHint{color:var(--dsw-alias-label-tertiary,#8b93a1);font-size:11px}.SOz1_a_sectAction{color:var(--dsw-alias-label-secondary,#6b7280);align-items:center;gap:8px;margin:14px 2px 8px;font-size:12px;font-weight:600;display:flex}.SOz1_a_backupGrid{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;display:grid}.SOz1_a_backupCard{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;flex-direction:column;gap:10px;padding:16px;display:flex}.SOz1_a_backupCard h3{margin:0;font-size:14px}.SOz1_a_backupCard p{color:var(--dsw-alias-label-secondary,#6b7280);margin:0;font-size:12px;line-height:18px}.SOz1_a_backupActions{flex-wrap:wrap;gap:8px;display:flex;position:relative}.SOz1_a_hiddenFile{opacity:0;pointer-events:none;width:1px;height:1px;position:absolute}.SOz1_a_backupInput{box-sizing:border-box;width:100%}.SOz1_a_backupCheck{cursor:pointer;align-items:center;gap:6px;font-size:12px;display:flex}.SOz1_a_backupWarn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#b45309)!important}.SOz1_a_backupMessage{color:var(--dsw-alias-label-secondary,#6b7280);grid-column:1/-1;font-size:12px}.SOz1_a_backupCheckList{flex-direction:column;gap:6px;max-height:260px;margin:10px 0 4px;padding-right:4px;display:flex;overflow-y:auto}.SOz1_a_backupCheckList .SOz1_a_backupCheck{justify-content:space-between;gap:8px}.SOz1_a_diagPage{flex-direction:column;gap:12px;height:100%;min-height:0;display:flex;overflow-y:auto}.SOz1_a_diagSummary{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 14px;font-size:12px;display:flex}.SOz1_a_diagSummaryItem{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;align-items:center;gap:6px;display:inline-flex}.SOz1_a_diagSummaryMeta{color:var(--dsw-alias-label-tertiary,#9ca3af);text-overflow:ellipsis;white-space:nowrap;max-width:320px;font-family:ui-monospace,Menlo,monospace;font-size:11px;overflow:hidden}.SOz1_a_diagSection{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;flex-direction:column;gap:8px;padding:12px 14px;display:flex}.SOz1_a_diagSection h3{color:var(--dsw-alias-label-primary,#1f2328);margin:0;font-size:13px;font-weight:600}.SOz1_a_diagCount{color:var(--dsw-alias-label-tertiary,#9ca3af);font-size:11px;font-weight:400}.SOz1_a_diagEmpty{color:var(--dsw-alias-label-secondary,#9ca3af);padding:8px 0;font-size:12px}.SOz1_a_diagBundle{border-top:1px solid var(--dsw-alias-border-l2,#f0f1f3);flex-direction:column;gap:6px;padding-top:8px;display:flex}.SOz1_a_diagBundle:first-of-type{border-top:none;padding-top:0}.SOz1_a_diagRow{flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:18px;display:flex}.SOz1_a_diagMeta{align-items:baseline;gap:8px;min-width:0;font-size:12px;display:flex}.SOz1_a_diagKey{color:var(--dsw-alias-label-tertiary,#9ca3af);flex-shrink:0;min-width:64px;font-size:11px}.SOz1_a_diagVal{color:var(--dsw-alias-label-primary,#1f2328);overflow-wrap:anywhere;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:500}.SOz1_a_diagIndex{background:var(--dsw-alias-bg-layer-2,#f3f4f6);min-width:18px;height:18px;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:9px;flex-shrink:0;justify-content:center;align-items:center;font-size:11px;font-weight:600;display:inline-flex}.SOz1_a_diagArrow{color:var(--dsw-alias-label-tertiary,#9ca3af);flex-shrink:0;font-size:12px}.SOz1_a_diagBadgeOfficial{background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;border-radius:9px;flex-shrink:0;align-items:center;height:18px;padding:0 8px;font-size:11px;font-weight:600;display:inline-flex}.SOz1_a_diagBadgeCommunity{background:var(--dsw-alias-bg-layer-2,#f3f4f6);height:18px;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:9px;flex-shrink:0;align-items:center;padding:0 8px;font-size:11px;display:inline-flex}.SOz1_a_diagBadgeShadow{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;border-radius:9px;flex-shrink:0;align-items:center;height:18px;padding:0 8px;font-size:11px;font-weight:600;display:inline-flex}.SOz1_a_diagList{flex-direction:column;gap:6px;display:flex}.SOz1_a_sectionOverview{color:var(--dsw-alias-label-tertiary,#8b93a1);text-overflow:ellipsis;white-space:nowrap;max-width:100%;padding:2px 0 6px;font-size:12px;line-height:18px;overflow:hidden}.SOz1_a_diagAlert{color:var(--dsw-alias-state-warn-primary,#b45309)}.SOz1_a_ovRow{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-radius:8px;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;padding:6px 10px;font-size:12px;line-height:18px;display:flex}.SOz1_a_ovArrow{color:var(--dsw-alias-label-tertiary,#9ca3af);flex-shrink:0;font-size:12px}.SOz1_a_ovByTag{background:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;text-overflow:ellipsis;white-space:nowrap;border-radius:9px;flex-shrink:0;align-items:center;max-width:260px;height:18px;padding:0 8px;font-size:11px;font-weight:600;display:inline-flex;overflow:hidden}.SOz1_a_ovFrom{color:var(--dsw-alias-label-secondary,#6b7280);text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:12px;overflow:hidden}.SOz1_a_orphRow{background:var(--dsw-alias-bg-layer-2,#f7f8fa);border-radius:8px;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;padding:6px 10px;font-size:12px;line-height:18px;display:flex}.SOz1_a_orphBadge{background:var(--dsw-alias-state-warn-primary,#b45309);color:#fff;white-space:nowrap;border-radius:9px;flex-shrink:0;align-items:center;height:18px;padding:0 8px;font-size:11px;font-weight:600;display:inline-flex}.SOz1_a_dragHandle{width:20px;height:20px;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:grab;-webkit-user-select:none;user-select:none;flex-shrink:0;justify-content:center;align-items:center;font-size:12px;line-height:20px;display:inline-flex}.SOz1_a_dragOver{outline:2px dashed var(--dsw-alias-brand-primary,#4f6ef7);outline-offset:2px;background:var(--dsw-alias-bg-layer-2,#f0f2f8);border-radius:8px}.SOz1_a_dragging{opacity:.45;background:var(--dsw-alias-bg-layer-2,#f3f4f6)}.SOz1_a_collapseHead{font:inherit;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer;text-align:left;background:0 0;border:none;align-items:center;gap:8px;width:100%;padding:0;font-size:13px;font-weight:600;display:flex}.SOz1_a_collapseIcon{color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0;display:inline-flex}.SOz1_a_collapseTitle{flex:1;min-width:0}.SOz1_a_collapseBody{border-top:1px solid var(--dsw-alias-border-l2,#f0f1f3);overflow-wrap:anywhere;flex-direction:column;gap:10px;min-width:0;margin-top:8px;padding-top:10px;display:flex}.SOz1_a_panelNote{color:var(--dsw-alias-label-secondary,#6b7280);margin:0;font-size:12px;line-height:18px}.SOz1_a_fixFallback{flex-direction:column;gap:6px;margin:8px 0;display:flex}.SOz1_a_fixFallbackText{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary,#1f2328);background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);resize:vertical;white-space:pre-wrap;word-break:break-all;border-radius:6px;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:16px}";
		const tagId = "dshmarket/Market.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dshmarket";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var Market_module_css_default = {
			"star": "SOz1_a_star",
			"backupWarn": "SOz1_a_backupWarn",
			"diagEmpty": "SOz1_a_diagEmpty",
			"switchOn": "SOz1_a_switchOn",
			"depBadge": "SOz1_a_depBadge",
			"diagSummaryItem": "SOz1_a_diagSummaryItem",
			"dragging": "SOz1_a_dragging",
			"groupName": "SOz1_a_groupName",
			"collapseTitle": "SOz1_a_collapseTitle",
			"groupActions": "SOz1_a_groupActions",
			"diagArrow": "SOz1_a_diagArrow",
			"row1": "SOz1_a_row1",
			"switchMixed": "SOz1_a_switchMixed",
			"diagBadgeOfficial": "SOz1_a_diagBadgeOfficial",
			"body": "SOz1_a_body",
			"top": "SOz1_a_top",
			"progress": "SOz1_a_progress",
			"catsWrap": "SOz1_a_catsWrap",
			"groupMember": "SOz1_a_groupMember",
			"catsCollapsed": "SOz1_a_catsCollapsed",
			"srcBtn": "SOz1_a_srcBtn",
			"diagSummary": "SOz1_a_diagSummary",
			"diagVal": "SOz1_a_diagVal",
			"catsToggle": "SOz1_a_catsToggle",
			"cmd": "SOz1_a_cmd",
			"ovByTag": "SOz1_a_ovByTag",
			"switch": "SOz1_a_switch",
			"inlineInput": "SOz1_a_inlineInput",
			"actLive": "SOz1_a_actLive",
			"title": "SOz1_a_title",
			"shot": "SOz1_a_shot",
			"tabSearchRow": "SOz1_a_tabSearchRow",
			"diagBadgeShadow": "SOz1_a_diagBadgeShadow",
			"owner": "SOz1_a_owner",
			"on": "SOz1_a_on",
			"groupRow": "SOz1_a_groupRow",
			"groupCreate": "SOz1_a_groupCreate",
			"warnLine": "SOz1_a_warnLine",
			"depLine": "SOz1_a_depLine",
			"ovArrow": "SOz1_a_ovArrow",
			"backupCard": "SOz1_a_backupCard",
			"sub": "SOz1_a_sub",
			"root": "SOz1_a_root",
			"backupInput": "SOz1_a_backupInput",
			"tabs": "SOz1_a_tabs",
			"diagAlert": "SOz1_a_diagAlert",
			"viewBtn": "SOz1_a_viewBtn",
			"tabSearch": "SOz1_a_tabSearch",
			"collapseHead": "SOz1_a_collapseHead",
			"foot": "SOz1_a_foot",
			"viewOn": "SOz1_a_viewOn",
			"head": "SOz1_a_head",
			"irow": "SOz1_a_irow",
			"viewBar": "SOz1_a_viewBar",
			"actWhy": "SOz1_a_actWhy",
			"groupAddPanel": "SOz1_a_groupAddPanel",
			"specTagFile": "SOz1_a_specTagFile",
			"ovFrom": "SOz1_a_ovFrom",
			"groupMembers": "SOz1_a_groupMembers",
			"groupHint": "SOz1_a_groupHint",
			"specTagGit": "SOz1_a_specTagGit",
			"spec": "SOz1_a_spec",
			"collapseIcon": "SOz1_a_collapseIcon",
			"banner": "SOz1_a_banner",
			"bannerHint": "SOz1_a_bannerHint",
			"err": "SOz1_a_err",
			"dragOver": "SOz1_a_dragOver",
			"irowMissing": "SOz1_a_irowMissing",
			"pager": "SOz1_a_pager",
			"catsRow": "SOz1_a_catsRow",
			"diagBadgeCommunity": "SOz1_a_diagBadgeCommunity",
			"topBtn": "SOz1_a_topBtn",
			"nm": "SOz1_a_nm",
			"orphBadge": "SOz1_a_orphBadge",
			"act": "SOz1_a_act",
			"sp": "SOz1_a_sp",
			"actBroken": "SOz1_a_actBroken",
			"specTag": "SOz1_a_specTag",
			"ovRow": "SOz1_a_ovRow",
			"collapseBody": "SOz1_a_collapseBody",
			"switchKnob": "SOz1_a_switchKnob",
			"descTight": "SOz1_a_descTight",
			"pagerPages": "SOz1_a_pagerPages",
			"diagRow": "SOz1_a_diagRow",
			"card": "SOz1_a_card",
			"diagSummaryMeta": "SOz1_a_diagSummaryMeta",
			"grow": "SOz1_a_grow",
			"modalNote": "SOz1_a_modalNote",
			"av": "SOz1_a_av",
			"swatches": "SOz1_a_swatches",
			"themesGrid": "SOz1_a_themesGrid",
			"titleRow": "SOz1_a_titleRow",
			"spin": "SOz1_a_spin",
			"barWave": "SOz1_a_barWave",
			"empty": "SOz1_a_empty",
			"backupCheckList": "SOz1_a_backupCheckList",
			"pageEllipsis": "SOz1_a_pageEllipsis",
			"backupGrid": "SOz1_a_backupGrid",
			"barFill": "SOz1_a_barFill",
			"assignRow": "SOz1_a_assignRow",
			"backupCheck": "SOz1_a_backupCheck",
			"diagKey": "SOz1_a_diagKey",
			"diagIndex": "SOz1_a_diagIndex",
			"groupHead": "SOz1_a_groupHead",
			"diagList": "SOz1_a_diagList",
			"desc": "SOz1_a_desc",
			"tab": "SOz1_a_tab",
			"loading": "SOz1_a_loading",
			"cats": "SOz1_a_cats",
			"diagSection": "SOz1_a_diagSection",
			"dragHandle": "SOz1_a_dragHandle",
			"tag": "SOz1_a_tag",
			"pageInfo": "SOz1_a_pageInfo",
			"orphRow": "SOz1_a_orphRow",
			"backupMessage": "SOz1_a_backupMessage",
			"diagCount": "SOz1_a_diagCount",
			"diagMeta": "SOz1_a_diagMeta",
			"src": "SOz1_a_src",
			"okState": "SOz1_a_okState",
			"hiddenFile": "SOz1_a_hiddenFile",
			"dot": "SOz1_a_dot",
			"panelNote": "SOz1_a_panelNote",
			"shots": "SOz1_a_shots",
			"bannerIcon": "SOz1_a_bannerIcon",
			"sectAction": "SOz1_a_sectAction",
			"staleAction": "SOz1_a_staleAction",
			"bar": "SOz1_a_bar",
			"fixFallback": "SOz1_a_fixFallback",
			"backupActions": "SOz1_a_backupActions",
			"diagBundle": "SOz1_a_diagBundle",
			"assignSelect": "SOz1_a_assignSelect",
			"actWarn": "SOz1_a_actWarn",
			"pct": "SOz1_a_pct",
			"deprecate": "SOz1_a_deprecate",
			"grid": "SOz1_a_grid",
			"sectionOverview": "SOz1_a_sectionOverview",
			"dshmSlide": "SOz1_a_dshmSlide",
			"diagPage": "SOz1_a_diagPage",
			"fixFallbackText": "SOz1_a_fixFallbackText"
		};
		//#endregion
		//#region src/client/Diagnostics.tsx
		/**
		* Diagnostics tab — issue #98: renders the profile composition check report
		* served by the host route /dsh-market/check (see src/check.ts). Below the
		* report sits the phase 2 action panel: community-bundle ordering (reorder
		* locally with ↑/↓ or drag, POST to /dsh-market/bundle-order) plus the AI-fix
		* clipboard prompt for HARD issues. The phase 3 snapshots & rollback and
		* plugin presets panels ship in later stacked PRs.
		*
		* Read-only view of the loading-layer stack and the conflict surface: bundle
		* order (official vs community), duplicate loader entry ids, peer dependency
		* mismatches, multi-version core packages, overrides and orphan patches. The
		* report shape mirrors the CheckReport interface in src/check.ts; it is
		* re-declared here because the client bundle is built independently of the
		* host tree.
		*/
		/**
		* A collapsible report section: header shows title + count + chevron; the
		* body stays mounted (hidden via CSS when collapsed) so every block keeps
		* its state. ALL blocks are collapsed by default — the summary strip above
		* gives the overview, and a problem block's title is highlighted and its
		* collapsed `overview` line shows the first issue, so nothing important is
		* hidden. Expand a block to see its full content.
		*/
		function Section(props) {
			const { title, count, empty, defaultOpen, problem = true, overview, alwaysShowBody = false, children } = props;
			const [open, setOpen] = (0, react.useState)(defaultOpen ?? false);
			const alert = problem && count > 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: Market_module_css_default.diagSection,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: Market_module_css_default.collapseHead,
						onClick: () => setOpen((o) => !o),
						"aria-expanded": open,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.collapseIcon,
								children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { size: 14 })
							}),
							alert && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.diagAlert,
								children: "⚠"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: `${Market_module_css_default.collapseTitle}${alert ? ` ${Market_module_css_default.diagAlert}` : ""}`,
								children: title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.diagCount,
								children: [
									"(",
									count,
									")"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow })
						]
					}),
					!open && overview !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.sectionOverview,
						children: overview
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.collapseBody,
						style: open ? void 0 : { display: "none" },
						children: count === 0 && !alwaysShowBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagEmpty,
							children: empty
						}) : children
					})
				]
			});
		}
		/** A collapsible section that KEEPS its children mounted (hidden via CSS when
		* collapsed) so the ordering panel below retains its loaded data and
		* in-progress edits across collapses.
		*/
		function CollapsibleSection(props) {
			const { title, count, open, onToggle, children } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: Market_module_css_default.diagSection,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: Market_module_css_default.collapseHead,
					onClick: onToggle,
					"aria-expanded": open,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Market_module_css_default.collapseIcon,
							children: open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { size: 14 })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Market_module_css_default.collapseTitle,
							children: title
						}),
						count !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: Market_module_css_default.diagCount,
							children: [
								"(",
								count,
								")"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow })
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: Market_module_css_default.collapseBody,
					style: open ? void 0 : { display: "none" },
					children
				})]
			});
		}
		/** Map an orphan patch reason (src/check.ts) to a locale key for its badge. */
		function orphanKindLabel(reason) {
			if (reason === "insert is not an array") return "orphanInsertNotArray";
			if (reason === "insert target not found") return "orphanInsertTargetMissing";
			if (reason === "insert target is not a group") return "orphanInsertTargetNotGroup";
			if (reason === "id required for non-insert patch") return "orphanIdRequired";
			if (reason === "patch target not found") return "orphanPatchTargetMissing";
			if (reason.startsWith("name mismatch")) return "orphanNameMismatch";
			return "orphanReasonOther";
		}
		/**
		* Fetch and render the profile check report. Refetches on every mount, so
		* switching tabs away and back re-runs the (cheap, read-only) analysis; the
		* ordering panel calls `refresh()` after applying an order.
		*/
		function Diagnostics(props) {
			const { t } = props;
			const [report, setReport] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [orderOpen, setOrderOpen] = (0, react.useState)(false);
			const [explainOpen, setExplainOpen] = (0, react.useState)(false);
			const [peerInfoOpen, setPeerInfoOpen] = (0, react.useState)(false);
			const [fixMsg, setFixMsg] = (0, react.useState)(null);
			/** The built AI-fix prompt when the clipboard path failed — rendered as a
			* selectable text block so the user can still copy it manually. */
			const [fixFallback, setFixFallback] = (0, react.useState)(null);
			/** Bump to re-run the /dsh-market/check fetch after an order apply. */
			const [version, setVersion] = (0, react.useState)(0);
			const refresh = (0, react.useCallback)(() => setVersion((v) => v + 1), []);
			/** Community bundle names from the report, in declared order. */
			const communityNames = (0, react.useMemo)(() => report === null ? [] : report.bundles.filter((bundle) => bundle.kind === "community").map((bundle) => bundle.name), [report]);
			/** Local editing state: re-synced whenever the report (re)loads. */
			const [order, setOrder] = (0, react.useState)(communityNames);
			const [orderMsg, setOrderMsg] = (0, react.useState)(null);
			const [orderErr, setOrderErr] = (0, react.useState)(null);
			const [orderBusy, setOrderBusy] = (0, react.useState)(false);
			/** Current-vs-candidate composition diff from a rejected static-composition
			* validation (#125 review): what the candidate would change, shown as a hint. */
			const [orderDiff, setOrderDiff] = (0, react.useState)(null);
			/**
			* Content identity of the last community order this draft synced to. A
			* refresh() refetch returns a NEW array even when the order is unchanged,
			* so a naive `setOrder(communityNames)` effect would wipe the user's
			* in-progress drag/↑↓ edits on every unrelated re-check. Only resync when
			* the report's community order actually CHANGED (apply order) — an
			* identical refetch keeps the draft (review M2).
			*/
			const syncedOrderRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const synced = syncedOrderRef.current;
				if (synced !== null && synced.length === communityNames.length && communityNames.every((name, i) => name === synced[i])) return;
				syncedOrderRef.current = communityNames;
				setOrder(communityNames);
			}, [communityNames]);
			/** Swap one community bundle with its neighbour (-1 up, +1 down). */
			const moveBundle = (index, delta) => {
				setOrder((prev) => {
					const next = [...prev];
					const target = index + delta;
					if (target < 0 || target >= next.length) return prev;
					[next[index], next[target]] = [next[target], next[index]];
					return next;
				});
			};
			/** Row being dragged (index into the local `order` draft). */
			const [dragIndex, setDragIndex] = (0, react.useState)(null);
			/** Row currently under the pointer, highlighted as the drop target. */
			const [dragOverIndex, setDragOverIndex] = (0, react.useState)(null);
			const onRowDragStart = (index) => (event) => {
				if (orderBusy) {
					event.preventDefault();
					return;
				}
				setDragIndex(index);
				event.dataTransfer?.setData?.("text/plain", order[index] ?? "");
				if (event.dataTransfer !== void 0) event.dataTransfer.effectAllowed = "move";
			};
			const onRowDragOver = (index) => (event) => {
				if (dragIndex === null || dragIndex === index) return;
				event.preventDefault();
				if (event.dataTransfer !== void 0) event.dataTransfer.dropEffect = "move";
				setDragOverIndex(index);
			};
			const onRowDragLeave = (index) => () => {
				setDragOverIndex((prev) => prev === index ? null : prev);
			};
			const onRowDrop = (index) => (event) => {
				event.preventDefault();
				const from = dragIndex;
				setDragIndex(null);
				setDragOverIndex(null);
				if (from === null || from === index) return;
				setOrder((prev) => {
					const next = [...prev];
					const [moved] = next.splice(from, 1);
					next.splice(index, 0, moved);
					return next;
				});
			};
			const onRowDragEnd = () => {
				setDragIndex(null);
				setDragOverIndex(null);
			};
			/** POST the current community order; the host statically validates the
			* candidate composition (dry-run replay) before writing. */
			const applyOrder = (target) => {
				if (orderBusy) return;
				setOrderBusy(true);
				setOrderMsg(null);
				setOrderErr(null);
				setOrderDiff(null);
				fetch("/dsh-market/bundle-order", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ order: target ?? order })
				}).then(async (res) => {
					const body = await res.json().catch(() => null);
					if (!res.ok || body?.ok !== true) {
						const diff = body?.trial?.diff;
						const overrides = diff?.overrides?.length ?? 0;
						const orphans = diff?.orphans?.length ?? 0;
						const duplicates = diff?.duplicates?.length ?? 0;
						setOrderDiff(overrides + orphans + duplicates > 0 ? {
							overrides,
							orphans,
							duplicates
						} : null);
						const firstMessage = body?.trial?.errors?.[0]?.message;
						setOrderErr(body?.trial !== void 0 ? t("orderTrialFail").replace("{0}", firstMessage !== void 0 ? String(firstMessage) : "") : String(body?.error ?? `HTTP ${String(res.status)}`));
						return;
					}
					setOrderDiff(null);
					setOrderMsg(t("orderApplied"));
					refresh();
				}).catch((err) => setOrderErr(err instanceof Error ? err.message : String(err))).finally(() => setOrderBusy(false));
			};
			(0, react.useEffect)(() => {
				let live = true;
				setError(null);
				fetch("/dsh-market/check", { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
					const body = await res.json();
					if (live) setReport(body);
				}).catch((err) => {
					if (live) setError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					live = false;
				};
			}, [version]);
			if (error !== null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Market_module_css_default.err,
				children: [t("checkLoadFail"), error]
			});
			if (report === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Market_module_css_default.loading,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: Market_module_css_default.spin,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 22 })
				}), t("checkLoading")]
			});
			const summary = report.summary;
			const suggested = report.suggestedOrder ?? null;
			const peerConfirmed = report.peerMismatches.filter((peer) => peer.satisfied === false);
			const peerInfo = report.peerMismatches.filter((peer) => peer.satisfied !== false);
			const catConflict = report.duplicates.length;
			const catDeps = report.peerMismatches.length + report.multiVersion.length;
			const catOrder = report.orderConflicts?.length ?? 0;
			const anyIssue = catConflict + catDeps + catOrder > 0;
			const hasHardIssues = summary.errors.length > 0 || report.duplicates.length > 0 || report.peerMismatches.some((peer) => peer.satisfied === false);
			/**
			* Build the AI-fix prompt (errors/warnings/order conflicts + scope) and
			* copy it to the clipboard. The user pastes it into a new conversation
			* and decides whether to send — the agent never runs automatically.
			* (A previous auto-open/prefill attempt was dropped: it was unreliable
			* across host versions, so plain copy + toast is the contract.)
			*/
			const startAgentFix = () => {
				const lines = [];
				lines.push(t("aiFixIntro").replace("{0}", report.profile));
				lines.push("");
				if (summary.errors.length > 0) {
					lines.push(`${t("checkErrors")}:`);
					for (const e of summary.errors) lines.push(`- ${e}`);
					lines.push("");
				}
				if (summary.warnings.length > 0) {
					lines.push(`${t("checkWarnings")}:`);
					for (const w of summary.warnings) lines.push(`- ${w}`);
					lines.push("");
				}
				if ((report.orderConflicts ?? []).length > 0) {
					lines.push(`${t("catOrder")}:`);
					for (const c of report.orderConflicts ?? []) lines.push(`- ${c.name}: ${c.reason}`);
					lines.push("");
				}
				lines.push(t("aiFixScope"));
				lines.push("");
				lines.push(t("aiFixConservative"));
				const prompt = lines.join("\n");
				setFixMsg(null);
				setFixFallback(null);
				const fallback = () => setFixFallback(prompt);
				if (typeof navigator.clipboard?.writeText === "function") navigator.clipboard.writeText(prompt).then(() => setFixMsg(t("aiFixCopied"))).catch(fallback);
				else fallback();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Market_module_css_default.diagPage,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.diagSummary,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: summary.ok ? Market_module_css_default.okState : Market_module_css_default.err,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
									state: summary.ok ? "done" : "error",
									size: 8
								}), summary.ok ? anyIssue ? t("checkIssues") : t("diagOkAll") : t("checkIssues")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.diagSummaryItem,
								title: t("checkDuplicates"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
										state: "error",
										size: 8
									}),
									t("catConflict"),
									": ",
									catConflict
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.diagSummaryItem,
								title: t("checkPeerMismatches"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
										state: "warning",
										size: 8
									}),
									t("catDeps"),
									": ",
									catDeps
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.diagSummaryItem,
								title: t("checkOrderTip"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
										state: "warning",
										size: 8
									}),
									t("catOrder"),
									": ",
									catOrder
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
							hasHardIssues && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								size: "sm",
								onClick: startAgentFix,
								title: t("aiFixHint"),
								children: t("aiFix")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "ghost",
								size: "sm",
								"aria-label": t("checkRefresh"),
								onClick: refresh,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, { size: 14 })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.diagSummaryMeta,
								title: report.profile,
								children: [
									t("checkProfile"),
									": ",
									report.profile
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.diagSummaryMeta,
								children: new Date(report.scannedAt).toLocaleString()
							})
						]
					}),
					fixMsg !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.okState,
						children: fixMsg
					}),
					fixFallback !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.fixFallback,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: Market_module_css_default.panelNote,
							children: t("aiFixFail")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							readOnly: true,
							rows: 10,
							className: Market_module_css_default.fixFallbackText,
							value: fixFallback,
							onFocus: (e) => e.currentTarget.select()
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(CollapsibleSection, {
						title: t("diagExplain"),
						open: explainOpen,
						onToggle: () => setExplainOpen((o) => !o),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: Market_module_css_default.panelNote,
							children: t("diagExplainText")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.diagList,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermBundle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermEntry")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermPeer")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermShadow")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermOrphan")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.spec,
									children: t("diagTermOrder")
								})
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkErrors"),
						count: summary.errors.length,
						empty: t("checkErrorsEmpty"),
						overview: summary.errors.length > 0 ? summary.errors[0] : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: summary.errors.map((line, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.err,
								children: line
							}, i))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkWarnings"),
						count: summary.warnings.length,
						empty: t("checkWarningsEmpty"),
						overview: summary.warnings.length > 0 ? summary.warnings[0] : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: summary.warnings.map((line, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.warnLine,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: line })
							}, i))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkBundles"),
						count: report.bundles.length,
						empty: t("checkBundlesEmpty"),
						problem: false,
						overview: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							t("checkOfficial"),
							" × ",
							report.bundles.filter((b) => b.kind === "official").length,
							" · ",
							t("checkCommunity"),
							" × ",
							report.bundles.filter((b) => b.kind === "community").length
						] }),
						children: report.bundles.map((bundle, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.diagBundle,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagRow,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.diagIndex,
											children: i + 1
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.diagArrow,
											children: "→"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.nm,
											children: bundle.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: bundle.kind === "official" ? Market_module_css_default.diagBadgeOfficial : Market_module_css_default.diagBadgeCommunity,
											children: bundle.kind === "official" ? t("checkOfficial") : t("checkCommunity")
										}),
										bundle.error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.err,
											children: bundle.error
										}),
										bundle.parseError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: Market_module_css_default.err,
											children: [
												t("checkPatch"),
												": ",
												bundle.parseError
											]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagMeta,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.diagKey,
										children: t("checkSource")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.spec,
										children: bundle.source
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagMeta,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.diagKey,
										children: t("checkEntries")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.spec,
										children: bundle.entries.length > 0 ? bundle.entries.join(", ") : "—"
									})]
								}),
								bundle.directory !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagMeta,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.diagKey,
										children: t("checkDir")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.spec,
										children: bundle.directory
									})]
								}),
								bundle.patchPath !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagMeta,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.diagKey,
										children: t("checkPatch")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.spec,
										children: bundle.patchPath
									})]
								})
							]
						}, bundle.name))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkDuplicates"),
						count: report.duplicates.length,
						empty: t("checkDuplicatesEmpty"),
						overview: report.duplicates.length > 0 ? `${report.duplicates[0]?.id} × ${report.duplicates[0]?.count}` : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: report.duplicates.map((dup) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.diagRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.diagVal,
										children: dup.id
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.err,
										children: ["× ", dup.count]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.spec,
										children: dup.layers.join(" / ")
									})
								]
							}, dup.id))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Section, {
						title: t("checkPeerMismatches"),
						count: peerConfirmed.length,
						empty: t("checkPeerEmpty"),
						overview: report.peerMismatches.length > 0 ? t("checkPeerOverview").replace("{0}", String(peerConfirmed.length)).replace("{1}", String(peerInfo.length)) : void 0,
						alwaysShowBody: peerInfo.length > 0,
						children: [peerConfirmed.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagEmpty,
							children: t("checkPeerEmpty")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: peerConfirmed.map((peer, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.diagRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.diagVal,
										children: peer.name
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.nm,
										children: peer.plugin
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.spec,
										children: [
											t("checkRange"),
											": ",
											peer.range
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.spec,
										children: [
											t("checkResolved"),
											": ",
											peer.resolved ?? "—"
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.diagBadgeShadow,
										children: t("checkUnsatisfied")
									})
								]
							}, i))
						}), peerInfo.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
							icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }),
							title: `${t("checkPeerInfo").replace("{0}", String(peerInfo.length))} (${peerInfo.length})`,
							expandable: true,
							open: peerInfoOpen,
							onToggle: () => setPeerInfoOpen((o) => !o),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.diagList,
								children: peerInfo.map((peer, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.diagRow,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
											className: Market_module_css_default.diagVal,
											children: peer.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.nm,
											children: peer.plugin
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: Market_module_css_default.spec,
											children: [
												t("checkRange"),
												": ",
												peer.range
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: Market_module_css_default.spec,
											children: [
												t("checkResolved"),
												": ",
												peer.resolved ?? "—"
											]
										}),
										peer.satisfied === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.okState,
											children: t("checkSatisfied")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.spec,
											children: t("checkUnknown")
										})
									]
								}, i))
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkMultiVersion"),
						count: report.multiVersion.length,
						empty: t("checkMultiEmpty"),
						overview: report.multiVersion.length > 0 ? `${report.multiVersion[0]?.name}: ${report.multiVersion[0]?.versions.join(" / ")}` : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: report.multiVersion.map((mv) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.diagRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.diagVal,
										children: mv.name
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.spec,
										children: mv.versions.join(" / ")
									}),
									mv.hoisted !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.spec,
										children: [
											t("checkHoisted"),
											": ",
											mv.hoisted
										]
									})
								]
							}, mv.name))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkOverrides"),
						count: report.overrides.length,
						empty: t("checkOverridesEmpty"),
						overview: report.overrides.length > 0 ? `${report.overrides[0]?.id} ← ${report.overrides[0]?.layer}` : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: report.overrides.map((ov, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.ovRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.diagVal,
										children: ov.id
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.ovArrow,
										children: "←"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.ovByTag,
										children: ov.layer
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.spec,
										children: t("checkOverridden")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.ovFrom,
										children: ov.overriddenLayers.join(", ")
									})
								]
							}, i))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Section, {
						title: t("checkOrphans"),
						count: report.orphans.length,
						empty: t("checkOrphansEmpty"),
						overview: report.orphans.length > 0 ? `${report.orphans[0]?.id}（${t(orphanKindLabel(report.orphans[0]?.reason ?? ""))}）` : void 0,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.diagList,
							children: report.orphans.map((orphan, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.orphRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.orphBadge,
										children: t(orphanKindLabel(orphan.reason))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
										className: Market_module_css_default.diagVal,
										children: orphan.id
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.nm,
										children: orphan.layer
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.spec,
										children: orphan.reason
									})
								]
							}, i))
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(CollapsibleSection, {
						title: t("orderSection"),
						count: order.length,
						open: orderOpen,
						onToggle: () => setOrderOpen((o) => !o),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: Market_module_css_default.panelNote,
								children: t("orderDragHint")
							}),
							report.orderConflicts !== void 0 && report.orderConflicts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.diagList,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.diagKey,
									children: t("orderConflicts")
								}), report.orderConflicts.map((conflict, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.warnLine,
									children: [
										conflict.name,
										" — ",
										conflict.reason
									]
								}, i))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									flexWrap: "wrap"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: order.length === 0 || orderBusy,
										onClick: () => applyOrder(),
										children: orderBusy ? "…" : t("orderApply")
									}),
									suggested !== null && suggested.ok === true && suggested.order.join("\0") !== communityNames.join("\0") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										disabled: orderBusy,
										onClick: () => applyOrder(suggested.order),
										children: t("orderSuggestApply")
									}),
									suggested !== null && suggested.ok === true && suggested.order.join("\0") === communityNames.join("\0") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.okState,
										children: t("orderAlreadyOptimal")
									}),
									order.join("\0") !== communityNames.join("\0") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										disabled: orderBusy,
										onClick: () => setOrder(communityNames),
										children: t("orderReset")
									}),
									orderMsg !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.okState,
										children: orderMsg
									}),
									orderErr !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.err,
										children: orderErr
									})
								]
							}),
							orderDiff !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.panelNote,
								children: t("orderDiffHint").replace("{0}", String(orderDiff.overrides)).replace("{1}", String(orderDiff.orphans)).replace("{2}", String(orderDiff.duplicates))
							}),
							suggested !== null && suggested.ok === false && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.warnLine,
								children: [
									t("orderSuggestHint"),
									" ⚠ ",
									suggested.cycle.join(" → ")
								]
							}),
							report.duplicateNames !== void 0 && report.duplicateNames.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.diagList,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.diagKey,
									children: t("duplicateNames")
								}), report.duplicateNames.map((dup, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.panelNote,
									children: [
										dup.name,
										" × ",
										dup.count,
										" — ",
										dup.layers.join(" / ")
									]
								}, i))]
							}),
							order.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.diagEmpty,
								children: "—"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.diagList,
								children: order.map((name, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									draggable: !orderBusy,
									className: [
										Market_module_css_default.diagRow,
										dragIndex === i ? Market_module_css_default.dragging : "",
										dragOverIndex === i ? Market_module_css_default.dragOver : ""
									].filter(Boolean).join(" "),
									onDragStart: onRowDragStart(i),
									onDragOver: onRowDragOver(i),
									onDragLeave: onRowDragLeave(i),
									onDrop: onRowDrop(i),
									onDragEnd: onRowDragEnd,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.dragHandle,
											"aria-label": t("orderDrag"),
											title: t("orderDrag"),
											children: "⠿"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.diagIndex,
											children: i + 1
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.nm,
											children: name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											draggable: false,
											"aria-label": t("orderUp"),
											disabled: i === 0 || orderBusy,
											onClick: () => moveBundle(i, -1),
											children: t("orderUp")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											draggable: false,
											"aria-label": t("orderDown"),
											disabled: i >= order.length - 1 || orderBusy,
											onClick: () => moveBundle(i, 1),
											children: t("orderDown")
										})
									]
								}, name))
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/MarketSection.tsx
		/**
		* The Market settings section: Discover / Themes / Installed tabs over the
		* /dsh-market/* host routes, with install/update/uninstall flows and the
		* pending-restart bookkeeping in sessionStorage.
		*/
		function isHostDependencyFinding(value) {
			if (value === null || typeof value !== "object") return false;
			const finding = value;
			return finding.code === "shared-host-package-dependency" && finding.severity === "warning" && finding.subject?.kind === "package" && typeof finding.subject.name === "string" && finding.evidence?.basis === "manifest-declaration" && typeof finding.evidence?.dependency === "string" && typeof finding.evidence.declaredRange === "string" && finding.evidence.declaredIn === "dependencies";
		}
		const HOST_DEPENDENCY_PREVIEW_LIMIT = 5;
		function HostDependencyDiagnostics({ findings, t }) {
			if (findings.length === 0) return null;
			const preview = findings.slice(0, HOST_DEPENDENCY_PREVIEW_LIMIT);
			const remaining = findings.length - preview.length;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Market_module_css_default.banner,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {
					size: 14,
					className: Market_module_css_default.bannerIcon
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: Market_module_css_default.grow,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("hostDependencyWarning") }),
						preview.map((finding) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.spec,
							children: [
								finding.subject.name,
								" → ",
								finding.evidence.dependency,
								"@",
								finding.evidence.declaredRange
							]
						}, `${finding.subject.name}:${finding.evidence.dependency}`)),
						remaining > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.spec,
							children: t("hostDependencyMore").replace("{0}", String(remaining))
						})
					]
				})]
			});
		}
		/** The state label + dot for one activation result (P0-2). */
		function activationMeta(state, t) {
			if (state === "live") return {
				label: t("stateLive"),
				dot: "done"
			};
			if (state === "restart") return {
				label: t("stateRestart"),
				dot: "warning"
			};
			if (state === "inert") return {
				label: t("stateInert"),
				dot: "warning"
			};
			if (state === "broken") return {
				label: t("stateBroken"),
				dot: "error"
			};
			if (state === "disabled") return {
				label: t("stateDisabled"),
				dot: "warning"
			};
			return {
				label: "—",
				dot: "warning"
			};
		}
		function phaseLabel(phase, t) {
			if (phase === "resolving") return t("phaseResolving");
			if (phase === "downloading") return t("phaseDownloading");
			if (phase === "linking") return t("phaseLinking");
			return t("phaseBuilding");
		}
		/**
		* Card avatar: the plugin owner's GitHub avatar (no API, browser-cached),
		* falling back to the initial-letter tile when it can't load.
		*/
		function OwnerAvatar({ name, owner }) {
			const [failed, setFailed] = (0, react.useState)(false);
			if (failed || owner === "") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: Market_module_css_default.av,
				style: { background: avatarColor(name) },
				children: name.replace(/^dsh[-_]/i, "").charAt(0).toUpperCase() || "P"
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
				className: Market_module_css_default.av,
				src: `https://github.com/${encodeURIComponent(owner)}.png?size=96`,
				alt: "",
				loading: "lazy",
				onError: () => setFailed(true)
			});
		}
		/**
		* AppStore-style screenshot strip in the install detail dialog (#61).
		* Curated registry screenshots win; otherwise images are extracted from the
		* repo README. Requests start only once the dialog opens; failures — no
		* README, no images, broken links — degrade to rendering nothing at all.
		*/
		function ScreenshotStrip({ plugin }) {
			const [shots, setShots] = (0, react.useState)([]);
			const [broken, setBroken] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				let live = true;
				setShots([]);
				setBroken([]);
				pluginScreenshots(plugin).then((list) => {
					if (live) setShots(list);
				});
				return () => {
					live = false;
				};
			}, [plugin]);
			const visible = shots.filter((src) => !broken.includes(src));
			if (visible.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: Market_module_css_default.shots,
				children: visible.map((src) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
					className: Market_module_css_default.shot,
					src,
					alt: "",
					loading: "lazy",
					decoding: "async",
					referrerPolicy: "no-referrer",
					onError: () => setBroken((prev) => prev.includes(src) ? prev : prev.concat(src))
				}, src))
			});
		}
		/**
		* Official-style market glyph: the shared block-grid brand mark converted to
		* the official monochrome icon form (16×16, fill="currentColor") so it
		* follows the active theme. Mirrors the settings-nav glyph used for the
		* "market" section id.
		*/
		function MarketLogo({ size = 16, style }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				"aria-hidden": "true",
				style,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fill: "currentColor",
					d: "M2.35 1.75H4.95A0.6 0.6 0 0 1 5.55 2.35V4.95A0.6 0.6 0 0 1 4.95 5.55H2.35A0.6 0.6 0 0 1 1.75 4.95V2.35A0.6 0.6 0 0 1 2.35 1.75ZM6.7 1.75H9.3A0.6 0.6 0 0 1 9.9 2.35V4.95A0.6 0.6 0 0 1 9.3 5.55H6.7A0.6 0.6 0 0 1 6.1 4.95V2.35A0.6 0.6 0 0 1 6.7 1.75ZM2.35 6.1H4.95A0.6 0.6 0 0 1 5.55 6.7V9.3A0.6 0.6 0 0 1 4.95 9.9H2.35A0.6 0.6 0 0 1 1.75 9.3V6.7A0.6 0.6 0 0 1 2.35 6.1ZM6.7 6.1H9.3A0.6 0.6 0 0 1 9.9 6.7V9.3A0.6 0.6 0 0 1 9.3 9.9H6.7A0.6 0.6 0 0 1 6.1 9.3V6.7A0.6 0.6 0 0 1 6.7 6.1ZM11.05 6.1H13.65A0.6 0.6 0 0 1 14.25 6.7V9.3A0.6 0.6 0 0 1 13.65 9.9H11.05A0.6 0.6 0 0 1 10.45 9.3V6.7A0.6 0.6 0 0 1 11.05 6.1ZM2.35 10.45H4.95A0.6 0.6 0 0 1 5.55 11.05V13.65A0.6 0.6 0 0 1 4.95 14.25H2.35A0.6 0.6 0 0 1 1.75 13.65V11.05A0.6 0.6 0 0 1 2.35 10.45ZM6.7 10.45H9.3A0.6 0.6 0 0 1 9.9 11.05V13.65A0.6 0.6 0 0 1 9.3 14.25H6.7A0.6 0.6 0 0 1 6.1 13.65V11.05A0.6 0.6 0 0 1 6.7 10.45ZM11.05 10.45H13.65A0.6 0.6 0 0 1 14.25 11.05V13.65A0.6 0.6 0 0 1 13.65 14.25H11.05A0.6 0.6 0 0 1 10.45 13.65V11.05A0.6 0.6 0 0 1 11.05 10.45Z"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					fill: "currentColor",
					d: "M11.05 1.75H13.65A0.6 0.6 0 0 1 14.25 2.35V4.95A0.6 0.6 0 0 1 13.65 5.55H11.05A0.6 0.6 0 0 1 10.45 4.95V2.35A0.6 0.6 0 0 1 11.05 1.75Z",
					transform: "rotate(9 12.35 3.65)"
				})]
			});
		}
		/**
		* Module-scope caches so re-entering the section renders instantly instead
		* of refetching and rebuilding from a spinner (#30 by @StarsTom). Module
		* state survives section switches; a background refetch keeps it current.
		*/
		let cachedRegistry = null;
		let cachedInstalled = null;
		/** Discover grid page-size choices — the catalog grows daily, so cap each page. */
		const PAGE_SIZES = [
			24,
			48,
			96
		];
		const DEFAULT_PAGE_SIZE = 24;
		const WEBDAV_STORAGE_KEY = "dshm-webdav";
		function savedWebdav() {
			try {
				const value = JSON.parse(localStorage.getItem(WEBDAV_STORAGE_KEY) ?? "{}");
				return {
					url: typeof value.url === "string" ? value.url : "",
					username: typeof value.username === "string" ? value.username : "",
					password: "",
					auto: value.auto === true
				};
			} catch {
				return {
					url: "",
					username: "",
					password: "",
					auto: false
				};
			}
		}
		function backupDependencies(value) {
			if (value === null || typeof value !== "object") throw new Error("invalid backup");
			const backup = value;
			if (backup.format !== "dsh-profile-backup" || backup.version !== .2) throw new Error("unsupported backup format");
			const files = backup.files;
			if (!Array.isArray(files)) throw new Error("unsupported backup format");
			const manifest = files.find((file) => file !== null && typeof file === "object" && file.path === "package.json");
			if (manifest?.json === null || typeof manifest?.json !== "object" || Array.isArray(manifest.json)) throw new Error("backup package.json is invalid");
			const dependencies = manifest.json.dependencies;
			if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) return {};
			if (!Object.values(dependencies).every((spec) => typeof spec === "string")) throw new Error("backup dependencies are invalid");
			return dependencies;
		}
		/** Sort field choices in the filter panel. */
		const SORT_FIELD_OPTIONS = [{
			key: "stars",
			label: "sortStars"
		}, {
			key: "added",
			label: "sortAdded"
		}];
		/** Sort direction choices in the filter panel (labels depend on the field). */
		const SORT_DIR_OPTIONS = ["desc", "asc"];
		/** Published-within choices in the filter panel. */
		const TIME_OPTIONS = [
			{
				key: "all",
				label: "timeAll"
			},
			{
				key: "day",
				label: "timeDay"
			},
			{
				key: "week",
				label: "timeWeek"
			},
			{
				key: "month",
				label: "timeMonth"
			},
			{
				key: "quarter",
				label: "timeQuarter"
			},
			{
				key: "year",
				label: "timeYear"
			}
		];
		function MarketSection(props) {
			const t = props.t;
			const initialWebdav = (0, react.useMemo)(savedWebdav, []);
			const localeSnap = (0, react.useSyncExternalStore)((cb) => props.locale.subscribe(cb), () => props.locale.getSnapshot());
			const lang = String(localeSnap.active).toLowerCase().startsWith("zh") ? "zh" : "en";
			const themeSnap = (0, react.useSyncExternalStore)(props.themeStore.subscribe, props.themeStore.getSnapshot);
			const [data, setData] = (0, react.useState)(cachedRegistry);
			const [loadError, setLoadError] = (0, react.useState)(false);
			const [installed, setInstalledState] = (0, react.useState)(cachedInstalled ?? {});
			const setInstalled = (0, react.useCallback)((value) => {
				cachedInstalled = value;
				setInstalledState(value);
			}, []);
			const [installedFiles, setInstalledFiles] = (0, react.useState)([]);
			const [skins, setSkins] = (0, react.useState)([]);
			const [tab, setTab] = (0, react.useState)(() => {
				const saved = sessionStorage.getItem("dshm-tab");
				if (saved !== null) sessionStorage.removeItem("dshm-tab");
				return saved || "discover";
			});
			const [q, setQ] = (0, react.useState)("");
			/** Per-tab searches stay independent: discover / themes / installed. */
			const [qThemes, setQThemes] = (0, react.useState)("");
			const [qInstalled, setQInstalled] = (0, react.useState)("");
			const [cat, setCat] = (0, react.useState)("all");
			const [confirming, setConfirming] = (0, react.useState)(null);
			const [busyUrl, setBusyUrl] = (0, react.useState)(null);
			/** Consecutive idle polls with a pending install that never landed (#32). */
			const idleStrikes = (0, react.useRef)(0);
			const [doneUrls, setDoneUrls] = (0, react.useState)([]);
			const [installError, setInstallError] = (0, react.useState)(null);
			/** Log export lifecycle for visible feedback (#84): idle → busy → done/fail. */
			const [exportState, setExportState] = (0, react.useState)("idle");
			/**
			* Programmatic log download with explicit feedback (#84) — the plain
			* `<a download>` gave no sign anything happened, and the error banner's
			* "export the log" wording pointed at text that was not clickable at all.
			* Success/failure surface as a primitives Toast (body portal, no layout
			* impact) instead of inline text.
			*/
			const doExportLog = (0, react.useCallback)(() => {
				setExportState("busy");
				fetch("/dsh-market/logs").then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
					const blob = await res.blob();
					const url = URL.createObjectURL(blob);
					const anchor = document.createElement("a");
					anchor.href = url;
					anchor.download = "dsh-market-log.txt";
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
					URL.revokeObjectURL(url);
					setExportState("done");
				}).catch(() => setExportState("fail"));
			}, []);
			/** Stable onDone for the export Toast — a fresh closure per render would
			* reset the Toast's auto-dismiss timer on every parent re-render. */
			const exportToastDone = (0, react.useCallback)(() => setExportState("idle"), []);
			const [updates, setUpdates] = (0, react.useState)({});
			const [updatingName, setUpdatingName] = (0, react.useState)(null);
			const [staleName, setStaleName] = (0, react.useState)(null);
			/** 1-based discover page; reset to 1 whenever the list shape changes. */
			const [page, setPage] = (0, react.useState)(1);
			/** Cards per discover page; changing it jumps back to page 1. */
			const [pageSize, setPageSize] = (0, react.useState)(DEFAULT_PAGE_SIZE);
			/** Determinate percent parsed from pnpm's Progress line, when available. */
			const [progressPct, setProgressPct] = (0, react.useState)(null);
			/**
			* Blocked build scripts from the last install or update: enables
			* approve-and-retry (#6; updates in #69). Exactly one of `plugin`
			* (retry installs it) / `updateName` (retry re-runs the update) is set.
			*/
			const [buildsSkipped, setBuildsSkipped] = (0, react.useState)(null);
			const [updatingAll, setUpdatingAll] = (0, react.useState)(false);
			const [updatedNames, setUpdatedNames] = (0, react.useState)([]);
			const [hotUrls, setHotUrls] = (0, react.useState)([]);
			const [hotNames, setHotNames] = (0, react.useState)([]);
			const [progressLine, setProgressLine] = (0, react.useState)(null);
			/** Per-package activation states from /dsh-market/installed + operations. */
			const [activations, setActivations] = (0, react.useState)({});
			/** #60: persisted disable list + custom groups, straight from /installed. */
			const [disabledNames, setDisabledNames] = (0, react.useState)([]);
			/**
			* Patch-layer flags (port of dsh-plugin-hub): packages whose bundle rows
			* the user patch layer disables / force-enables. The UI treats them as the
			* real switch state so hand-edited cordis.patch.yml toggles are visible.
			*/
			const [patchDisabledNames, setPatchDisabledNames] = (0, react.useState)([]);
			const [patchForcedNames, setPatchForcedNames] = (0, react.useState)([]);
			const [groups, setGroups] = (0, react.useState)({});
			const [groupOrder, setGroupOrder] = (0, react.useState)([]);
			/** Installed-tab sub-view: flat list or groups (All-plugins was removed —
			* it duplicated the Discover tab). */
			const [installedView, setInstalledView] = (0, react.useState)("list");
			const [togglingName, setTogglingName] = (0, react.useState)(null);
			const [creatingGroup, setCreatingGroup] = (0, react.useState)(false);
			const [newGroupName, setNewGroupName] = (0, react.useState)("");
			const [renamingGroup, setRenamingGroup] = (0, react.useState)(null);
			const [renamingValue, setRenamingValue] = (0, react.useState)("");
			const [deletingGroup, setDeletingGroup] = (0, react.useState)(null);
			/** Open group picker: which group and whether it adds plugins or themes. */
			const [addPanel, setAddPanel] = (0, react.useState)(null);
			const [assignFor, setAssignFor] = (0, react.useState)(null);
			const [assignTarget, setAssignTarget] = (0, react.useState)("");
			/** Structured progress from pnpm ndjson (P1-6). */
			const [progressPhase, setProgressPhase] = (0, react.useState)(null);
			const [progressCurrent, setProgressCurrent] = (0, react.useState)(null);
			const [progressDone, setProgressDone] = (0, react.useState)(0);
			const [cancelling, setCancelling] = (0, react.useState)(false);
			/** Server-side operation lock from /dsh-market/status (#91). */
			const [hostBusy, setHostBusy] = (0, react.useState)(false);
			/** Non-live activation results from the last operation, shown as a banner. */
			const [activationWarnings, setActivationWarnings] = (0, react.useState)([]);
			const [hostDependencyFindings, setHostDependencyFindings] = (0, react.useState)([]);
			/** Plugin name awaiting uninstall confirmation (Modal). */
			const [removeConfirm, setRemoveConfirm] = (0, react.useState)(null);
			const [removingName, setRemovingName] = (0, react.useState)(null);
			const [removedCount, setRemovedCount] = (0, react.useState)(0);
			/** Toggles whose live fiber did not follow the switch — restart to apply. */
			const [toggleRestart, setToggleRestart] = (0, react.useState)(0);
			/**
			* Dismissal of the host-reported restart notice, keyed to the current boot
			* so it reappears after a restart that did not happen and after any new
			* change. sessionStorage, not local: closing the tab is a fresh start.
			*/
			const [restartNoticeDismissed, setRestartNoticeDismissed] = (0, react.useState)(false);
			/** Client-part plugins toggled this session — their UI needs a refresh. */
			const [refreshNames, setRefreshNames] = (0, react.useState)([]);
			const [envReady, setEnvReady] = (0, react.useState)(true);
			const [envFixing, setEnvFixing] = (0, react.useState)(false);
			const [envFailed, setEnvFailed] = (0, react.useState)(false);
			const [bootId, setBootId] = (0, react.useState)(null);
			/** One-click restart (#14 by @ysyyhhh): server capability + in-flight state. */
			const [restartEnabled, setRestartEnabled] = (0, react.useState)(false);
			const [restarting, setRestarting] = (0, react.useState)(false);
			const [showTop, setShowTop] = (0, react.useState)(false);
			const [backupBusy, setBackupBusy] = (0, react.useState)(false);
			const [backupMessage, setBackupMessage] = (0, react.useState)(null);
			const [backupRestored, setBackupRestored] = (0, react.useState)(false);
			const [pendingBackup, setPendingBackup] = (0, react.useState)(null);
			const [pendingDependencies, setPendingDependencies] = (0, react.useState)({});
			const [webdavUrl, setWebdavUrl] = (0, react.useState)(initialWebdav.url);
			const [webdavUser, setWebdavUser] = (0, react.useState)(initialWebdav.username);
			const [webdavPassword, setWebdavPassword] = (0, react.useState)(initialWebdav.password);
			const [autoBackup, setAutoBackup] = (0, react.useState)(initialWebdav.auto);
			/** GitHub token — session memory only, never written to any storage. */
			const [gistToken, setGistToken] = (0, react.useState)("");
			/** Gist id — persisted across reloads (non-sensitive: the Gist itself is private). */
			const [gistId, setGistId] = (0, react.useState)(() => {
				try {
					return localStorage.getItem("dshm-gist-id") ?? "";
				} catch {
					return "";
				}
			});
			/** Export mode: 'update' PATCHes the Gist in the field, 'create' makes a new one. */
			const [gistMode, setGistMode] = (0, react.useState)(() => {
				try {
					return localStorage.getItem("dshm-gist-id") ? "update" : "create";
				} catch {
					return "create";
				}
			});
			const [gistBusy, setGistBusy] = (0, react.useState)(false);
			const [gistMessage, setGistMessage] = (0, react.useState)(null);
			const [gistOk, setGistOk] = (0, react.useState)(false);
			const [gistResult, setGistResult] = (0, react.useState)(null);
			/** Export picker: open state, selected plugin names, include-config flag. */
			const [exportOpen, setExportOpen] = (0, react.useState)(false);
			const [exportSelection, setExportSelection] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [exportIncludeConfig, setExportIncludeConfig] = (0, react.useState)(false);
			/** Export failure shown INSIDE the picker so it is never hidden behind it. */
			const [exportError, setExportError] = (0, react.useState)(null);
			/** Bundle-only plugin names from /dsh-market/installed (picker list). */
			const [installedBundles, setInstalledBundles] = (0, react.useState)([]);
			const bodyRef = (0, react.useRef)(null);
			/** Hidden file input behind the Import button (a Button can't host an <input>). */
			const fileInputRef = (0, react.useRef)(null);
			const [sortField, setSortField] = (0, react.useState)("stars");
			const [sortDir, setSortDir] = (0, react.useState)("desc");
			/** Direction labels adapt to the field: stars → asc/desc, added → oldest/newest. */
			const sortDirLabel = (dir) => sortField === "added" ? dir === "desc" ? "sortNewest" : "sortOldest" : dir === "desc" ? "sortDesc" : "sortAsc";
			const [timeRange, setTimeRange] = (0, react.useState)("all");
			const [filterOpen, setFilterOpen] = (0, react.useState)(false);
			const [catsOpen, setCatsOpen] = (0, react.useState)(false);
			/** Page-size switcher dropdown (primitives Menu). */
			const [sizeOpen, setSizeOpen] = (0, react.useState)(false);
			/** WebDAV provider-preset dropdown (primitives Menu). */
			const [presetOpen, setPresetOpen] = (0, react.useState)(false);
			/** Install-command disclosure inside the confirm dialog. */
			const [cmdOpen, setCmdOpen] = (0, react.useState)(false);
			/** Per-row "why is it not live" disclosure (installed tab). */
			const [whyOpen, setWhyOpen] = (0, react.useState)(null);
			/** Restore-confirm dialog (replaces window.confirm). */
			const [restoreConfirmOpen, setRestoreConfirmOpen] = (0, react.useState)(false);
			/** Plugins that failed to install during a restore (replaces window.alert). */
			const [restoreErrors, setRestoreErrors] = (0, react.useState)([]);
			const [visibleCats, setVisibleCats] = (0, react.useState)(null);
			const catsWrapRef = (0, react.useRef)(null);
			const refreshInstalled = (0, react.useCallback)((force) => {
				fetch("/dsh-market/installed", { cache: "no-store" }).then((res) => res.json()).then((body) => {
					setInstalled(body.installed || {});
					setInstalledFiles(Array.isArray(body.present) ? body.present : Object.keys(body.installed || {}));
					setSkins(body.live || []);
					if (Array.isArray(body.disabled)) setDisabledNames(body.disabled);
					if (Array.isArray(body.patchDisabled)) setPatchDisabledNames(body.patchDisabled);
					if (Array.isArray(body.patchForced)) setPatchForcedNames(body.patchForced);
					if (body.groups && typeof body.groups === "object") setGroups(body.groups);
					if (Array.isArray(body.groupOrder)) setGroupOrder(body.groupOrder);
					setInstalledBundles(Array.isArray(body.bundles) ? body.bundles.filter((name) => typeof name === "string") : []);
					if (body.activation && typeof body.activation === "object") setActivations(body.activation);
					const findings = body.diagnostics?.schema === "dsh-market/diagnostics/v1" && Array.isArray(body.diagnostics.findings) ? body.diagnostics.findings.filter(isHostDependencyFinding) : [];
					setHostDependencyFindings(findings);
				}).catch(() => {});
				fetch("/dsh-market/updates" + (force === true ? "?force=1" : ""), { cache: "no-store" }).then((res) => res.json()).then((body) => setUpdates(body.updates || {})).catch(() => {});
			}, []);
			(0, react.useMemo)(() => new Set(disabledNames), [disabledNames]);
			/** Effective switch state: market disable list ∪ user-patch-layer disables. */
			const effectiveDisabledSet = (0, react.useMemo)(() => /* @__PURE__ */ new Set([...disabledNames, ...patchDisabledNames]), [disabledNames, patchDisabledNames]);
			(0, react.useEffect)(() => {
				fetch("/dsh-market/registry", { cache: "no-store" }).then((res) => {
					if (!res.ok) throw new Error("HTTP " + res.status);
					return res.json();
				}).then((body) => {
					cachedRegistry = body.registry;
					setData(body.registry);
				}).catch(() => setLoadError(true));
				fetch("/dsh-market/status", { cache: "no-store" }).then((res) => res.json()).then((status) => {
					setEnvReady(status.pnpm !== false);
					if (typeof status.boot === "string") {
						setBootId(status.boot);
						try {
							setRestartNoticeDismissed(sessionStorage.getItem("dshm-restart-dismissed") === status.boot);
						} catch {}
					}
					setRestartEnabled(status.restart === true);
				}).catch(() => {});
				refreshInstalled();
			}, [refreshInstalled]);
			(0, react.useEffect)(() => {
				if (bootId === null) return;
				const saved = readSession("dshm-restart");
				if (saved === null) return;
				if (saved.boot !== bootId) {
					sessionStorage.removeItem("dshm-restart");
					return;
				}
				if (Array.isArray(saved.doneUrls) && saved.doneUrls.length > 0) setDoneUrls(saved.doneUrls);
				if (Array.isArray(saved.updated) && saved.updated.length > 0) setUpdatedNames(saved.updated);
				if (typeof saved.removed === "number" && saved.removed > 0) setRemovedCount(saved.removed);
				if (typeof saved.toggled === "number" && saved.toggled > 0) setToggleRestart(saved.toggled);
			}, [bootId]);
			(0, react.useEffect)(() => {
				if (bootId === null) return;
				if (doneUrls.length === 0 && updatedNames.length === 0 && removedCount === 0 && toggleRestart === 0) {
					sessionStorage.removeItem("dshm-restart");
					return;
				}
				sessionStorage.setItem("dshm-restart", JSON.stringify({
					boot: bootId,
					doneUrls,
					updated: updatedNames,
					removed: removedCount,
					toggled: toggleRestart
				}));
			}, [
				bootId,
				doneUrls,
				updatedNames,
				removedCount,
				toggleRestart
			]);
			const fixEnv = (0, react.useCallback)(() => {
				setEnvFixing(true);
				setEnvFailed(false);
				fetch("/dsh-market/setup-pnpm", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				}).then((res) => res.json()).then((body) => {
					if (body.ok) setEnvReady(true);
					else {
						setEnvFailed(true);
						if (typeof body.error === "string") setInstallError(body.error);
					}
				}).catch(() => setEnvFailed(true)).finally(() => setEnvFixing(false));
			}, []);
			(0, react.useEffect)(() => {
				const pending = readSession("dshm-pending");
				if (pending !== null && typeof pending.url === "string") setBusyUrl(pending.url);
			}, []);
			(0, react.useEffect)(() => {
				if (busyUrl === null && updatingName === null) {
					setProgressLine(null);
					setProgressPhase(null);
					setProgressCurrent(null);
					setProgressDone(0);
					setCancelling(false);
					return;
				}
				const timer = setInterval(() => {
					fetch("/dsh-market/status", { cache: "no-store" }).then((res) => res.json()).then((status) => {
						setHostBusy(status.busy === true);
						if (status.active) {
							setCancelling(status.cancelling === true);
							if (status.phase !== null && status.phase !== void 0) {
								setProgressPhase(status.phase);
								setProgressCurrent(status.currentPackage ?? null);
								setProgressDone(status.done ?? 0);
								setProgressLine(null);
								if (typeof status.size === "number" && status.size > 0 && typeof status.downloaded === "number") setProgressPct(Math.max(4, Math.min(96, Math.round(status.downloaded / status.size * 100))));
							} else {
								setProgressLine((status.lastLine || "…") + "  (" + status.seconds + "s)");
								setProgressPhase(null);
								setProgressCurrent(null);
								setProgressDone(0);
								const m = /resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/.exec(status.lastLine || "");
								if (m !== null && Number(m[1]) > 0) {
									const done = Number(m[2]) + Number(m[3]) + Number(m[4]);
									setProgressPct(Math.max(4, Math.min(96, Math.round(done / Number(m[1]) * 100))));
								}
							}
						} else {
							setProgressLine(null);
							setProgressPct(null);
							setProgressPhase(null);
							setProgressCurrent(null);
							setProgressDone(0);
							setCancelling(false);
							setInstalled(status.installed || {});
							if (readSession("dshm-pending") !== null && busyUrl !== null && status.busy !== true) {
								if (data !== null && data.plugins.some((p) => p.url === busyUrl && isInstalled(p, status.installed || {}))) {
									idleStrikes.current = 0;
									sessionStorage.removeItem("dshm-pending");
									setDoneUrls((urls) => urls.includes(busyUrl) ? urls : urls.concat(busyUrl));
									setBusyUrl(null);
								} else if (++idleStrikes.current >= 2) {
									idleStrikes.current = 0;
									sessionStorage.removeItem("dshm-pending");
									setBusyUrl(null);
									setInstallError(t("installFail") + " — " + t("exportLog"));
								}
							}
						}
					}).catch(() => {});
				}, 2e3);
				return () => clearInterval(timer);
			}, [
				busyUrl,
				updatingName,
				data
			]);
			const plugins = (0, react.useMemo)(() => data === null ? [] : visiblePlugins(data.plugins, {
				category: cat,
				query: q,
				lang,
				sort: `${sortField}-${sortDir}`,
				sinceDays: timeRange === "all" ? void 0 : TIME_RANGE_DAYS[timeRange]
			}), [
				data,
				q,
				cat,
				lang,
				sortField,
				sortDir,
				timeRange
			]);
			(0, react.useEffect)(() => {
				setPage(1);
			}, [
				q,
				cat,
				sortField,
				sortDir,
				timeRange
			]);
			const totalPages = Math.max(1, Math.ceil(plugins.length / pageSize));
			const currentPage = Math.min(page, totalPages);
			const pagePlugins = plugins.slice((currentPage - 1) * pageSize, currentPage * pageSize);
			const scrollToTop = () => {
				const el = bodyRef.current;
				if (el) {
					if (typeof el.scrollTo === "function") el.scrollTo({
						top: 0,
						behavior: "smooth"
					});
					else el.scrollTop = 0;
				}
			};
			const goToPage = (next) => {
				setPage(Math.max(1, Math.min(next, totalPages)));
				scrollToTop();
			};
			const changePageSize = (size) => {
				setPageSize(size);
				setPage(1);
				scrollToTop();
			};
			/** Download a host endpoint as a file — primitives Button can't be an <a download>.
			* Prefers the server's Content-Disposition filename (e.g. the timestamped
			* backup export) and falls back to the caller's name. */
			const downloadFile = (0, react.useCallback)((url, filename) => {
				fetch(url).then((res) => {
					if (!res.ok) throw new Error("HTTP " + res.status);
					const disposition = res.headers.get("content-disposition");
					if (disposition !== null) {
						const match = /filename="?([^";]+)"?/.exec(disposition);
						if (match !== null && match[1] !== void 0 && match[1] !== "") filename = match[1];
					}
					return res.blob();
				}).then((blob) => {
					const a = document.createElement("a");
					a.href = URL.createObjectURL(blob);
					a.download = filename;
					a.click();
					setTimeout(() => URL.revokeObjectURL(a.href), 2e3);
				}).catch((error) => setInstallError(String(error)));
			}, []);
			const doInstall = (0, react.useCallback)((plugin) => {
				setBuildsSkipped(null);
				setConfirming(null);
				setInstallError(null);
				setActivationWarnings([]);
				setBusyUrl(plugin.url);
				sessionStorage.setItem("dshm-pending", JSON.stringify({ url: plugin.url }));
				fetch("/dsh-market/install", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ url: plugin.url })
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					setBusyUrl(null);
					sessionStorage.removeItem("dshm-pending");
					if (status === 200 && body.ok && body.hot && plugin.category === "theme") {
						sessionStorage.setItem("dshm-toast", JSON.stringify([plugin.name]));
						sessionStorage.setItem("dshm-tab", "themes");
						location.reload();
						return;
					}
					if (body.cancelled === true) {
						refreshInstalled();
						if (body.partial === true) setInstallError(t("partialNote"));
						return;
					}
					if (status === 200 && body.ok) {
						sessionStorage.setItem("dshm-tab", "installed");
						if (body.activation && typeof body.activation === "object") {
							setActivations((prev) => ({
								...prev,
								...body.activation
							}));
							const warns = Object.entries(body.activation).filter(([, info]) => info.state !== "live" && info.state !== "missing").map(([name, info]) => ({
								name,
								info
							}));
							setActivationWarnings(warns);
						}
						if (body.hot) {
							setDoneUrls((urls) => urls.filter((url) => url !== plugin.url));
							setHotUrls((urls) => urls.includes(plugin.url) ? urls : urls.concat(plugin.url));
							setHotNames((names) => names.includes(plugin.name) ? names : names.concat(plugin.name));
						} else setDoneUrls((urls) => urls.includes(plugin.url) ? urls : urls.concat(plugin.url));
						refreshInstalled();
					} else {
						if (status === 409) {
							setInstallError(t("busyWait"));
							return;
						}
						if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) setBuildsSkipped({
							plugin,
							names: body.ignoredBuilds.map(String)
						});
						const text = (v) => typeof v === "string" ? v : v && typeof v.text === "string" ? v.text : v == null ? "" : JSON.stringify(v);
						const detail = text(body.error) || [text(body.stderr), text(body.stdout)].filter(Boolean).join("\n").trim() || "exit " + body.exitCode;
						setInstallError(t("installFail") + ": " + plugin.name + " — " + detail.trim().slice(-600));
					}
				}).catch(() => {});
			}, [refreshInstalled, t]);
			/**
			* Restart the host and reload once the boot id changes (#14 by @ysyyhhh).
			* The 202 races the process's SIGTERM, so network errors on the initial
			* request are expected and treated as "restart under way".
			*/
			const doRestart = (0, react.useCallback)(() => {
				if (bootId === null || restarting) return;
				const previousBoot = bootId;
				setRestarting(true);
				setInstallError(null);
				const awaitNewBoot = () => {
					const deadline = Date.now() + 6e4;
					const poll = () => {
						fetch("/dsh-market/status", { cache: "no-store" }).then((res) => res.json()).then((next) => {
							if (typeof next.boot === "string" && next.boot !== previousBoot) {
								location.reload();
								return;
							}
							retry();
						}).catch(retry);
					};
					const retry = () => {
						if (Date.now() > deadline) {
							setRestarting(false);
							setInstallError(t("restartTimeout"));
							return;
						}
						setTimeout(poll, 1500);
					};
					poll();
				};
				const requestRestart = (attemptsLeft) => {
					fetch("/dsh-market/restart", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}"
					}).then((res) => res.json().then((body) => ({
						status: res.status,
						body
					}))).then(({ status, body }) => {
						if (status === 202 && body.ok === true) {
							awaitNewBoot();
							return;
						}
						if (status === 409 && attemptsLeft > 0) {
							setTimeout(() => requestRestart(attemptsLeft - 1), 1500);
							return;
						}
						setRestarting(false);
						setInstallError(t("restartFail") + ": " + String(body.error || "HTTP " + String(status)));
					}).catch(awaitNewBoot);
				};
				requestRestart(10);
			}, [
				bootId,
				restarting,
				t
			]);
			/** Cancel the running plugin command (#6 by @qichuang321). */
			const doCancel = (0, react.useCallback)(() => {
				fetch("/dsh-market/cancel", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				}).catch(() => {});
			}, []);
			const doUpdate = (0, react.useCallback)((name, force = false) => {
				setInstallError(null);
				setActivationWarnings([]);
				setStaleName(null);
				setUpdatingName(name);
				return fetch("/dsh-market/update", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(force ? {
						name,
						force: true
					} : { name })
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (body.cancelled === true) {
						refreshInstalled();
						if (body.partial === true) setInstallError(t("partialNote"));
						return;
					}
					if (status === 200 && body.ok) {
						setUpdatedNames((names) => names.concat(name));
						if (body.activation && typeof body.activation === "object") setActivations((prev) => ({
							...prev,
							...body.activation
						}));
						refreshInstalled();
					} else {
						if (status === 409) {
							setInstallError(t("busyWait"));
							return;
						}
						if (body.stale === true) setStaleName(name);
						if (Array.isArray(body.ignoredBuilds) && body.ignoredBuilds.length > 0) setBuildsSkipped({
							updateName: name,
							names: body.ignoredBuilds.map(String)
						});
						const text = (v) => typeof v === "string" ? v : v && typeof v.text === "string" ? v.text : v == null ? "" : JSON.stringify(v);
						const detail = text(body.error) || [text(body.stderr), text(body.stdout)].filter(Boolean).join("\n").trim() || "exit " + body.exitCode;
						setInstallError(t("updateFail") + ": " + name + " — " + detail.trim().slice(-600));
					}
				}).catch((error) => setInstallError(t("updateFail") + ": " + String(error))).finally(() => setUpdatingName(null));
			}, [refreshInstalled, t]);
			const doUseSkin = (0, react.useCallback)((name) => {
				setInstallError(null);
				fetch("/dsh-market/use-skin", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name })
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (status === 200 && body.ok) {
						sessionStorage.setItem("dshm-toast", JSON.stringify([name]));
						sessionStorage.setItem("dshm-toast-mode", "theme");
						sessionStorage.setItem("dshm-tab", "themes");
						location.reload();
					} else setInstallError(String(body.error || "failed"));
				}).catch((error) => setInstallError(String(error)));
			}, []);
			const doUninstall = (0, react.useCallback)((name) => {
				setRemoveConfirm(null);
				setInstallError(null);
				setActivationWarnings([]);
				setRemovingName(name);
				return fetch("/dsh-market/uninstall", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name })
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (status === 200 && body.ok) {
						if (!body.hot) setRemovedCount((n) => n + 1);
						refreshInstalled();
					} else {
						if (body.cancelled === true) {
							refreshInstalled();
							if (body.partial === true) setInstallError(t("partialNote"));
							return;
						}
						const text = (v) => typeof v === "string" ? v : v && typeof v.text === "string" ? v.text : v == null ? "" : JSON.stringify(v);
						setInstallError((text(body.error) || text(body.stderr) || "error").trim().slice(-600));
					}
				}).catch((error) => setInstallError(String(error))).finally(() => setRemovingName(null));
			}, [refreshInstalled]);
			/** Live enable/disable of one installed plugin (#60). `reload` opts the
			* card-level theme flow into a page refresh so the visual result lands
			* immediately (mirrors the use-skin reload on activate). */
			const doToggle = (0, react.useCallback)((name, enabled, reload = false) => {
				setTogglingName(name);
				setInstallError(null);
				return fetch("/dsh-market/toggle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						name,
						enabled
					})
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (status === 200 && body.ok) {
						if (Array.isArray(body.disabled)) setDisabledNames(body.disabled);
						if (Array.isArray(body.live)) setSkins(body.live);
						if (body.activation && typeof body.activation === "object") setActivations((prev) => ({
							...prev,
							...body.activation
						}));
						if (body.restart === true) setToggleRestart((n) => n + 1);
						if (body.refresh === true) setRefreshNames((names) => names.includes(name) ? names : names.concat(name));
						refreshInstalled();
						if (reload) {
							sessionStorage.removeItem("dshm-toast");
							sessionStorage.removeItem("dshm-toast-mode");
							sessionStorage.setItem("dshm-tab", "themes");
							location.reload();
						}
					} else {
						const text = (v) => typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
						setInstallError(text(body.reason) || text(body.error) || t("toggleFail"));
						if (body.restart === true) setToggleRestart((n) => n + 1);
						if (body.refresh === true) setRefreshNames((names) => names.includes(name) ? names : names.concat(name));
					}
				}).catch((error) => setInstallError(String(error))).finally(() => setTogglingName(null));
			}, [refreshInstalled, t]);
			/** Adopt the groups payload returned by POST /dsh-market/groups. */
			const setGroupPayload = (0, react.useCallback)((body) => {
				if (body.groups && typeof body.groups === "object") setGroups(body.groups);
				if (Array.isArray(body.groupOrder)) setGroupOrder(body.groupOrder);
				if (Array.isArray(body.disabled)) setDisabledNames(body.disabled);
			}, []);
			/** One POST /dsh-market/groups round trip (create/rename/delete/members/toggle). */
			const doGroupAction = (0, react.useCallback)((payload) => {
				setInstallError(null);
				return fetch("/dsh-market/groups", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (status === 200 && body.ok) {
						setGroupPayload(body);
						if (Array.isArray(body.restartMembers) && body.restartMembers.length > 0) setToggleRestart((n) => n + body.restartMembers.length);
						if (Array.isArray(body.refreshMembers) && body.refreshMembers.length > 0) setRefreshNames((names) => [.../* @__PURE__ */ new Set([...names, ...body.refreshMembers])]);
						refreshInstalled();
						return true;
					}
					const text = (v) => typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
					setInstallError(text(body.error) || t("toggleFail"));
					if (Array.isArray(body.restartMembers) && body.restartMembers.length > 0) setToggleRestart((n) => n + body.restartMembers.length);
					if (Array.isArray(body.refreshMembers) && body.refreshMembers.length > 0) setRefreshNames((names) => [.../* @__PURE__ */ new Set([...names, ...body.refreshMembers])]);
					return false;
				}).catch((error) => {
					setInstallError(String(error));
					return false;
				});
			}, [
				refreshInstalled,
				setGroupPayload,
				t
			]);
			const doGroupToggle = (0, react.useCallback)((name, enabled) => {
				return doGroupAction({
					action: "toggle",
					name,
					enabled
				});
			}, [doGroupAction]);
			const doCreateGroup = (0, react.useCallback)(() => {
				const name = newGroupName.trim();
				if (name === "") return;
				doGroupAction({
					action: "create",
					name
				}).then((ok) => {
					if (ok) {
						setCreatingGroup(false);
						setNewGroupName("");
					}
				});
			}, [doGroupAction, newGroupName]);
			const doRenameGroup = (0, react.useCallback)((name) => {
				const newName = renamingValue.trim();
				if (newName === "" || newName === name) {
					setRenamingGroup(null);
					return;
				}
				doGroupAction({
					action: "rename",
					name,
					newName
				}).then((ok) => {
					if (ok) {
						setRenamingGroup(null);
						setRenamingValue("");
					}
				});
			}, [doGroupAction, renamingValue]);
			const doDeleteGroup = (0, react.useCallback)((name) => {
				doGroupAction({
					action: "delete",
					name
				}).then((ok) => {
					if (ok) setDeletingGroup(null);
				});
			}, [doGroupAction]);
			const doAssign = (0, react.useCallback)((name) => {
				const group = assignTarget;
				if (group === "") return;
				const members = groups[group] ?? [];
				doGroupAction({
					action: "set-members",
					name: group,
					members: [...members, name]
				}).then((ok) => {
					if (ok) {
						setAssignFor(null);
						setAssignTarget("");
					}
				});
			}, [
				assignTarget,
				doGroupAction,
				groups
			]);
			const doRemoveMember = (0, react.useCallback)((group, name) => {
				const members = (groups[group] ?? []).filter((member) => member !== name);
				doGroupAction({
					action: "set-members",
					name: group,
					members
				});
			}, [doGroupAction, groups]);
			/** Add one installed plugin to a group (picker stays open for batch adds). */
			const doAddMember = (0, react.useCallback)((group, name) => {
				const members = groups[group] ?? [];
				doGroupAction({
					action: "set-members",
					name: group,
					members: [...members, name]
				});
			}, [doGroupAction, groups]);
			const selfName = installed["dshmarket"] !== void 0 ? "dshmarket" : "dsh-market";
			const updatableNames = Object.keys(installed).filter((name) => name !== selfName && !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable);
			const doUpdateAll = (0, react.useCallback)(() => {
				const names = updatableNames.slice();
				setUpdatingAll(true);
				const next = () => {
					const name = names.shift();
					if (name === void 0) {
						setUpdatingAll(false);
						return;
					}
					doUpdate(name).then(next, next);
				};
				next();
			}, [updatableNames, doUpdate]);
			const finishRestore = (0, react.useCallback)((body) => {
				const errors = Array.isArray(body.errors) ? body.errors : [];
				setRestoreErrors(errors.map((item) => `${String(item.name)}: ${String(item.error)}`));
				setBackupRestored(true);
				setBackupMessage(t("restoreDone"));
				if (errors.length === 0) {
					setPendingBackup(null);
					setPendingDependencies({});
				}
				refreshInstalled(true);
			}, [refreshInstalled, t]);
			const previewBackup = (0, react.useCallback)((backup) => {
				const dependencies = backupDependencies(backup);
				setPendingBackup(backup);
				setPendingDependencies(dependencies);
				setBackupMessage(t("restorePreviewDone"));
				setRestoreErrors([]);
				setTab("installed");
			}, [t]);
			/** Actually run the restore; the confirm dialog gates this (previously window.confirm). */
			const doRestore = (0, react.useCallback)(() => {
				if (pendingBackup === null) return Promise.resolve();
				setRestoreConfirmOpen(false);
				setBackupBusy(true);
				setBackupMessage(null);
				setRestoreErrors([]);
				return fetch("/dsh-market/restore", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ backup: pendingBackup })
				}).then(async (response) => {
					const body = await response.json();
					if (!response.ok) throw new Error(String(body.error || "restore failed"));
					finishRestore(body);
				}).catch((error) => setBackupMessage(String(error))).finally(() => setBackupBusy(false));
			}, [finishRestore, pendingBackup]);
			const runWebdav = (0, react.useCallback)((action) => {
				if (webdavUrl.trim() === "") return;
				setBackupBusy(true);
				setBackupMessage(null);
				setRestoreErrors([]);
				fetch("/dsh-market/webdav", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action,
						url: webdavUrl.trim(),
						username: webdavUser,
						password: webdavPassword
					})
				}).then(async (response) => {
					const body = await response.json();
					if (!response.ok) throw new Error(String(body.error || "WebDAV failed"));
					if (action === "restore") previewBackup(body.backup);
					if (action === "backup") {
						try {
							localStorage.setItem("dshm-webdav-last", String(Date.now()));
						} catch {}
						setBackupMessage(t("backupDone"));
					}
				}).catch((error) => setBackupMessage(String(error))).finally(() => setBackupBusy(false));
			}, [
				previewBackup,
				t,
				webdavPassword,
				webdavUrl,
				webdavUser
			]);
			/** Map the server's token-source string to a localized label. */
			const gistSourceLabel = (source) => {
				if (source === "token") return t("gistSrcToken");
				if (source === "env") return t("gistSrcEnv");
				if (source === "gh") return t("gistSrcGh");
				return source;
			};
			/** Turn any failure (server error, network error, timeout) into a friendly message. */
			const gistErrorMessage = (error) => {
				const err = error;
				const name = typeof err?.name === "string" ? err.name : "";
				const code = typeof err?.code === "string" ? err.code : "";
				if (code === "timeout" || name === "TimeoutError" || name === "AbortError") return t("gistErrTimeout");
				if (code === "network") return t("gistErrNetwork");
				if (code === "auth") return t("gistErrAuth");
				if (code === "notfound") return t("gistErrNotFound");
				if (code === "rate-limit") return t("gistErrRateLimit");
				if (code === "invalid") return t("gistErrInvalid");
				if (error instanceof TypeError) return t("gistErrNetwork");
				return String(error);
			};
			const runGist = (0, react.useCallback)((action) => {
				setGistBusy(true);
				setGistMessage(null);
				setGistOk(false);
				setGistResult(null);
				setRestoreErrors([]);
				setExportError(null);
				const body = {
					action,
					token: gistToken.trim()
				};
				if (action === "import") body.gistId = gistId.trim();
				if (action === "export" && gistMode === "update") {
					if (gistId.trim() === "") {
						setGistBusy(false);
						setGistMessage(t("gistErrNoId"));
						setGistOk(false);
						return;
					}
					body.gistId = gistId.trim();
				}
				if (action === "export") {
					const allNames = /* @__PURE__ */ new Set([...Object.keys(installed), ...installedBundles]);
					if (!(exportSelection.size === allNames.size && exportSelection.size > 0)) {
						body.includeDeps = [...exportSelection];
						if (exportIncludeConfig) body.includeConfig = true;
					}
				}
				fetch("/dsh-market/gist", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(3e4)
				}).then(async (response) => {
					let body = {};
					try {
						body = await response.json();
					} catch {}
					if (!response.ok) {
						const error = new Error(String(body.error || "Gist failed"));
						if (typeof body.code === "string") error.code = body.code;
						throw error;
					}
					if (action === "export") {
						setGistResult(body);
						const ref = body;
						if (typeof ref.gistId === "string" && ref.gistId !== "") {
							setGistId(ref.gistId);
							setGistMode("update");
							try {
								localStorage.setItem("dshm-gist-id", ref.gistId);
							} catch {}
						}
						setGistMessage(t("gistExportDone"));
						setGistOk(true);
						setExportOpen(false);
					} else if (action === "import") previewBackup(body.backup);
					else {
						const source = typeof body.source === "string" ? body.source : "";
						setGistMessage(t("gistVerifySource").replace("{0}", gistSourceLabel(source)));
						setGistOk(true);
					}
				}).catch((error) => {
					const message = gistErrorMessage(error);
					setGistMessage(message);
					setGistOk(false);
					if (action === "export") setExportError(message);
				}).finally(() => setGistBusy(false));
			}, [
				exportIncludeConfig,
				exportSelection,
				gistId,
				gistToken,
				installed,
				installedBundles,
				previewBackup,
				t
			]);
			/** The picker list: dependency plugins + bundle-only plugins, deduplicated. */
			const exportOptions = (0, react.useMemo)(() => {
				return [.../* @__PURE__ */ new Set([...Object.keys(installed), ...installedBundles])].sort();
			}, [installed, installedBundles]);
			/** Classify an install spec for the export picker badge. */
			const specKind = (spec) => {
				if (spec === void 0) return "bundle";
				if (/^file:/i.test(spec)) return "file";
				if (/^(github:|git\+|git:)/i.test(spec)) return "git";
				return "npm";
			};
			const openExportPicker = (0, react.useCallback)(() => {
				const names = /* @__PURE__ */ new Set([...Object.keys(installed), ...installedBundles]);
				setExportSelection(new Set(names));
				setExportIncludeConfig(false);
				setExportOpen(true);
			}, [installed, installedBundles]);
			(0, react.useEffect)(() => {
				try {
					localStorage.setItem(WEBDAV_STORAGE_KEY, JSON.stringify({
						url: webdavUrl,
						username: webdavUser,
						auto: autoBackup
					}));
				} catch {}
				if (!autoBackup || webdavUrl.trim() === "") return;
				let last = 0;
				try {
					last = Number(localStorage.getItem("dshm-webdav-last")) || 0;
				} catch {}
				if (Date.now() - last >= 864e5) runWebdav("backup");
			}, [
				autoBackup,
				runWebdav,
				webdavUrl,
				webdavUser
			]);
			const sessionPendingRestart = doneUrls.length + updatedNames.length + removedCount + toggleRestart + (backupRestored ? 1 : 0);
			/**
			* Plugins the HOST reports as restart-pending, independent of what this
			* browser session happens to remember. Installing and then reloading the
			* page used to leave no restart affordance at all: the banner is built
			* from session state, while the Installed tab only says "activates on
			* restart" in passing — so the user was told a restart was needed and
			* given nothing to press. Dismissible, because a standing banner nobody
			* wants to act on right now is just noise (it returns next session, or
			* as soon as another change lands).
			*/
			const hostPendingNames = Object.keys(activations).filter((name) => activations[name]?.state === "restart");
			const showHostPending = hostPendingNames.length > 0 && !restartNoticeDismissed && sessionPendingRestart === 0;
			const pendingRestart = sessionPendingRestart > 0 ? sessionPendingRestart : showHostPending ? hostPendingNames.length : 0;
			const displayedInstalled = pendingBackup === null ? installed : {
				...pendingDependencies,
				...installed
			};
			const missingRestoreCount = Object.keys(pendingDependencies).filter((name) => !installedFiles.includes(name)).length;
			const hasUpdates = Object.keys(installed).some((name) => !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable);
			/** Live status line: structured phase, or the human-line fallback. */
			const phasePart = progressPhase != null ? phaseLabel(progressPhase, t) + (progressCurrent !== null ? " · " + progressCurrent : "") + (progressDone > 0 ? " · " + t("packagesDone").replace("{0}", String(progressDone)) : "") : progressLine || t("progressHint");
			const progressText = cancelling ? t("cancelling") + " · " + phasePart : phasePart;
			const filterItems = (0, react.useMemo)(() => [
				{
					type: "label",
					id: "f-sort",
					text: t("filterSort")
				},
				...SORT_FIELD_OPTIONS.map((opt) => ({
					id: "field:" + opt.key,
					label: t(opt.label)
				})),
				{
					type: "separator",
					id: "f-sep1"
				},
				{
					type: "label",
					id: "f-dir",
					text: t("filterDir")
				},
				...SORT_DIR_OPTIONS.map((dir) => ({
					id: "dir:" + dir,
					label: t(sortDirLabel(dir))
				})),
				{
					type: "separator",
					id: "f-sep2"
				},
				{
					type: "label",
					id: "f-time",
					text: t("filterTime")
				},
				...TIME_OPTIONS.map((opt) => ({
					id: "time:" + opt.key,
					label: t(opt.label)
				}))
			], [t, sortField]);
			const filterSelectedIds = (0, react.useMemo)(() => [
				"field:" + sortField,
				"dir:" + sortDir,
				"time:" + timeRange
			], [
				sortField,
				sortDir,
				timeRange
			]);
			const onFilterSelect = (id) => {
				if (id.startsWith("field:")) setSortField(id.slice(6));
				else if (id.startsWith("dir:")) setSortDir(id.slice(4));
				else if (id.startsWith("time:")) setTimeRange(id.slice(5));
			};
			const themePlugins$1 = data === null ? [] : themePlugins(data.plugins);
			/** Themes-tab search narrows by name/owner/description. */
			const filteredThemePlugins = (0, react.useMemo)(() => {
				const needle = qThemes.trim().toLowerCase();
				if (needle === "") return themePlugins$1;
				return themePlugins$1.filter((p) => {
					const desc = p.description && (p.description[lang] || p.description.en) || "";
					return p.name.toLowerCase().includes(needle) || (p.owner || "").toLowerCase().includes(needle) || desc.toLowerCase().includes(needle);
				});
			}, [
				themePlugins$1,
				qThemes,
				lang
			]);
			/** The catalog entry a deprecated plugin's `replacement` names, if any. */
			const replacementOf = (p) => p.deprecated === true && p.replacement !== void 0 ? data?.plugins.find((r) => r.name === p.replacement) : void 0;
			const pluginCard = (p) => {
				const desc = p.description && (p.description[lang] || p.description.en) || "";
				const done = doneUrls.includes(p.url) || hotUrls.includes(p.url);
				const already = isInstalled(p, installed);
				const busy = busyUrl === p.url;
				const replacement = replacementOf(p);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: Market_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.row1,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OwnerAvatar, {
									name: p.name,
									owner: p.owner || ""
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { minWidth: 0 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.nm,
										children: [p.name, p.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.depBadge,
											children: t("deprecatedBadge")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.owner,
										children: [
											p.owner,
											typeof p.stars === "number" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: Market_module_css_default.star,
												children: " · ★ " + p.stars
											}),
											p.added && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: Market_module_css_default.star,
												children: " · " + t("published") + " " + p.added
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									className: Market_module_css_default.srcBtn,
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 14 }),
									onClick: () => window.open(p.url, "_blank", "noopener"),
									children: t("viewSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.desc,
							children: desc
						}),
						p.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.deprecate,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.depLine,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚠️ ", t("deprecatedWarn")] }), replacement !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: replacement.url,
									target: "_blank",
									rel: "noreferrer",
									children: t("replacementHint") + " " + replacement.name
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.foot,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.tag,
									children: data.categories[p.category] && (data.categories[p.category][lang] || data.categories[p.category].en) || p.category
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
								done ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.okState,
									children: t("installedBadge")
								}) : already ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.okState,
									children: t("alreadyInstalled")
								}) : busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									disabled: true,
									children: t("installing")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									disabled: busyUrl !== null || !envReady,
									onClick: () => setConfirming(p),
									children: t("install")
								})
							]
						}),
						busy && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.progress,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.spin,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 14 })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: Market_module_css_default.grow,
									children: progressText
								}),
								progressPct !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: Market_module_css_default.pct,
									children: [progressPct, "%"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: cancelling,
									onClick: doCancel,
									children: cancelling ? t("cancelling") : t("cancelOp")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.bar,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: progressPct !== null ? Market_module_css_default.barFill : `${Market_module_css_default.barFill} ${Market_module_css_default.barWave}`,
										style: progressPct !== null ? { width: `${progressPct}%` } : void 0
									})
								})
							]
						})
					]
				}, p.url);
			};
			const installedNameOf = (p) => matchInstalledName(p, installed);
			const bootEntries = typeof window !== "undefined" && window.__DSH_BOOT__ && Array.isArray(window.__DSH_BOOT__.entries) ? window.__DSH_BOOT__.entries : [];
			const themePluginCard = (p) => {
				const instName = installedNameOf(p);
				if (instName === null) return pluginCard(p);
				const mounted = (skins.includes(instName) || bootEntries.some((e) => e.id === instName)) && !effectiveDisabledSet.has(instName);
				const desc = p.description && (p.description[lang] || p.description.en) || "";
				const replacement = replacementOf(p);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: Market_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.row1,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(OwnerAvatar, {
									name: p.name,
									owner: p.owner || ""
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { minWidth: 0 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.nm,
										children: [p.name, p.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.depBadge,
											children: t("deprecatedBadge")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.owner,
										children: [
											p.owner,
											typeof p.stars === "number" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: Market_module_css_default.star,
												children: " · ★ " + p.stars
											}),
											p.added && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: Market_module_css_default.star,
												children: " · " + t("published") + " " + p.added
											})
										]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									className: Market_module_css_default.srcBtn,
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 14 }),
									onClick: () => window.open(p.url, "_blank", "noopener"),
									children: t("viewSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.desc,
							children: desc
						}),
						p.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.deprecate,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.depLine,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚠️ ", t("deprecatedWarn")] }), replacement !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: replacement.url,
									target: "_blank",
									rel: "noreferrer",
									children: t("replacementHint") + " " + replacement.name
								})]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.foot,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
								removingName === instName ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: true,
									children: t("uninstalling")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									onClick: () => setRemoveConfirm(instName),
									children: t("uninstall")
								}),
								effectiveDisabledSet.has(instName) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.spec,
									children: t("disabledState")
								}),
								mounted ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.okState,
									children: t("themeActive")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: togglingName !== null,
									onClick: () => doToggle(instName, false, true),
									children: t("themeDeactivate")
								})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									onClick: () => doUseSkin(instName),
									children: t("themeApply")
								})
							]
						})
					]
				}, p.url);
			};
			const themeCard = (id, label, swatch) => {
				const active = themeSnap !== null && themeSnap.preference === id;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: Market_module_css_default.card,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.swatches,
						children: swatch.map((c, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("i", { style: { background: c } }, i))
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.foot,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.nm,
								children: label
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
							active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.okState,
								children: t("themeActive")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "primary",
								size: "sm",
								onClick: () => {
									try {
										props.theme.setTheme(id);
									} catch (error) {
										setInstallError(String(error));
									}
								},
								children: t("themeApply")
							})
						]
					})]
				}, "th-" + id);
			};
			const categories = data === null ? [] : Object.keys(data.categories);
			(0, react.useLayoutEffect)(() => {
				setVisibleCats(null);
			}, [lang, categories.length]);
			(0, react.useLayoutEffect)(() => {
				if (catsOpen || visibleCats !== null) return;
				const el = catsWrapRef.current;
				if (el === null) return;
				const chips = [...el.children].filter((c) => c.dataset?.chip === "1");
				if (chips.length === 0) return;
				const first = chips[0];
				const rowThreeTop = first.offsetTop + (first.offsetHeight + 6) * 2 - 3;
				let fits = 0;
				for (const chip of chips) if (chip.offsetTop < rowThreeTop) fits += 1;
				setVisibleCats(fits >= chips.length ? fits : Math.max(1, fits - 1));
			}, [
				catsOpen,
				visibleCats,
				data
			]);
			/** Installed plugins the market itself cannot group (#60). */
			const groupableNames = Object.keys(installed).filter((name) => name !== "dsh-market" && name !== "dshmarket");
			/** Names already inside some group; everything else shows under "ungrouped". */
			const groupedNames = (0, react.useMemo)(() => new Set(Object.values(groups).flat()), [groups]);
			const ungroupedNames = groupableNames.filter((name) => !groupedNames.has(name));
			/** Installed package names the catalog classifies as themes (client-side
			* mirror of the server's classification; themes are exclusive per group). */
			const installedThemeNames = (0, react.useMemo)(() => {
				const names = /* @__PURE__ */ new Set();
				if (data === null) return names;
				for (const [name, spec] of Object.entries(installed)) {
					const entry = entryForDep(data.plugins, name, String(spec));
					if (entry !== void 0 && entry.category === "theme") names.add(name);
				}
				return names;
			}, [data, installed]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: Market_module_css_default.root,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.head,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.titleRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MarketLogo, {
										size: 22,
										style: { flexShrink: 0 }
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
										className: Market_module_css_default.title,
										children: t("nav")
									}),
									(() => {
										const self = installed["dshmarket"] !== void 0 ? "dshmarket" : "dsh-market";
										return updates[self] && updates[self].updateAvailable && !updatedNames.includes(self) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "primary",
											size: "sm",
											disabled: updatingName !== null || busyUrl !== null,
											onClick: () => {
												setTab("installed");
												doUpdate(self);
											},
											children: updatingName === self ? t("updating") : t("marketUpdate")
										});
									})(),
									updatableNames.length >= 2 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: updatingAll || updatingName !== null || busyUrl !== null || removingName !== null,
										onClick: () => {
											setTab("installed");
											doUpdateAll();
										},
										children: updatingAll ? t("updating") : t("updateAll") + " (" + updatableNames.length + ")"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.sub,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("subtitle") + (data ? " · " + data.count : "") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
										disabled: exportState === "busy",
										onClick: doExportLog,
										children: exportState === "busy" ? t("exportingLog") : t("exportLog")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.tabs,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: tab === "discover" ? `${Market_module_css_default.tab} ${Market_module_css_default.on}` : Market_module_css_default.tab,
										onClick: () => setTab("discover"),
										children: t("tabDiscover")
									}),
									themeSnap !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: tab === "themes" ? `${Market_module_css_default.tab} ${Market_module_css_default.on}` : Market_module_css_default.tab,
										onClick: () => setTab("themes"),
										children: t("tabThemes")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										className: tab === "installed" ? `${Market_module_css_default.tab} ${Market_module_css_default.on}` : Market_module_css_default.tab,
										onClick: () => {
											setTab("installed");
											refreshInstalled(true);
										},
										children: [t("tabInstalled") + (Object.keys(installed).length > 0 ? " (" + Object.keys(installed).length + ")" : ""), hasUpdates && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
											state: "error",
											size: 7,
											className: Market_module_css_default.dot
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: tab === "backup" ? `${Market_module_css_default.tab} ${Market_module_css_default.on}` : Market_module_css_default.tab,
										onClick: () => setTab("backup"),
										children: t("tabBackup")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										className: tab === "diagnostics" ? `${Market_module_css_default.tab} ${Market_module_css_default.on}` : Market_module_css_default.tab,
										onClick: () => setTab("diagnostics"),
										children: t("tabDiagnostics")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow })
								]
							}),
							!envReady && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCordisPluginOutline14, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.grow,
										children: envFailed ? t("envFixFail") : t("envMissing")
									}),
									!envFailed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: envFixing,
										onClick: fixEnv,
										children: envFixing ? t("envFixing") : t("envFix")
									})
								]
							}),
							backupMessage !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.backupMessage,
								children: backupMessage
							}),
							restoreErrors.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {
									size: 14,
									className: Market_module_css_default.bannerIcon
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: Market_module_css_default.grow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: t("restorePartial") }) }), restoreErrors.map((error) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: Market_module_css_default.spec,
										children: error
									}, error))]
								})]
							}),
							tab === "installed" && pendingBackup !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.grow,
										children: t("restoreMissing").replace("{0}", String(missingRestoreCount))
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: backupBusy,
										onClick: () => setRestoreConfirmOpen(true),
										children: backupBusy ? t("backupWorking") : t("restoreStart")
									})
								]
							}),
							hotUrls.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSparkle16, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.grow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: hotUrls.length }),
											" ",
											t("hotBanner")
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										onClick: () => {
											sessionStorage.setItem("dshm-toast", JSON.stringify(hotNames));
											sessionStorage.setItem("dshm-tab", "installed");
											location.reload();
										},
										children: t("refresh")
									})
								]
							}),
							refreshNames.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.grow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: refreshNames.length }),
											" ",
											t("refreshBanner")
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										onClick: () => {
											sessionStorage.setItem("dshm-tab", "installed");
											location.reload();
										},
										children: t("refresh")
									})
								]
							}),
							pendingRestart > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline14, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.grow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: pendingRestart }),
											" ",
											t("restartBanner")
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
										label: t("restartHint"),
										side: "bottom",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.bannerHint,
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutline14, { size: 14 })
										})
									}),
									restartEnabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: restarting || hostBusy || busyUrl !== null || updatingName !== null || removingName !== null,
										onClick: doRestart,
										children: restarting ? t("restarting") : t("restartNow")
									}),
									showHostPending && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "ghost",
										size: "sm",
										"aria-label": t("dismissNotice"),
										onClick: () => {
											setRestartNoticeDismissed(true);
											try {
												sessionStorage.setItem("dshm-restart-dismissed", String(bootId ?? ""));
											} catch {}
										},
										children: t("dismiss")
									})
								]
							}),
							activationWarnings.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.banner,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {
									size: 14,
									className: Market_module_css_default.bannerIcon
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.grow,
									children: activationWarnings.map(({ name, info }) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: name }),
										" — ",
										activationMeta(info.state, t).label,
										info.reasons.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: Market_module_css_default.spec,
											children: [
												"（",
												info.reasons.join(" / "),
												"）"
											]
										})
									] }, name))
								})]
							}),
							tab === "installed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HostDependencyDiagnostics, {
								findings: hostDependencyFindings,
								t
							})
						]
					}),
					buildsSkipped !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.banner,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {
								size: 14,
								className: Market_module_css_default.bannerIcon
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: Market_module_css_default.grow,
								children: [
									t("buildsSkipped"),
									" ",
									buildsSkipped.names.join(", ")
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								disabled: busyUrl !== null,
								onClick: () => {
									const { plugin, updateName, names } = buildsSkipped;
									setBuildsSkipped(null);
									fetch("/dsh-market/approve-builds", {
										method: "POST",
										headers: { "content-type": "application/json" },
										body: JSON.stringify({ packages: names })
									}).then((res) => res.json()).then((body) => {
										if (!body.ok) setInstallError(String(body.error || "approve failed"));
										else if (plugin !== void 0) doInstall(plugin);
										else if (updateName !== void 0) doUpdate(updateName);
									}).catch((error) => setInstallError(String(error)));
								},
								children: t("approveBuilds")
							})
						]
					}),
					installError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.err,
						children: [installError, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.staleAction,
							children: [staleName !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								onClick: () => doUpdate(staleName, true),
								children: t("updateNow")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
								disabled: exportState === "busy",
								onClick: doExportLog,
								children: exportState === "busy" ? t("exportingLog") : t("exportLog")
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.body,
						ref: bodyRef,
						onScroll: (e) => setShowTop(e.currentTarget.scrollTop > 400),
						children: tab === "backup" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.backupGrid,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: Market_module_css_default.backupCard,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("backupLocal") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("backupHint") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: Market_module_css_default.backupWarn,
											children: t("credsWarning")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: Market_module_css_default.backupActions,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "primary",
													size: "sm",
													icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, { size: 14 }),
													disabled: backupBusy,
													onClick: () => downloadFile("/dsh-market/backup", "dsh-profile-backup.json"),
													children: backupBusy ? t("backupWorking") : t("backupDownload")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "outline",
													size: "sm",
													icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, { size: 14 }),
													disabled: backupBusy,
													onClick: () => fileInputRef.current?.click(),
													children: backupBusy ? t("backupWorking") : t("backupImport")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													ref: fileInputRef,
													type: "file",
													accept: "application/json,.json",
													className: Market_module_css_default.hiddenFile,
													tabIndex: -1,
													"aria-hidden": "true",
													disabled: backupBusy,
													onChange: (event) => {
														const file = event.currentTarget.files?.[0];
														event.currentTarget.value = "";
														if (file !== void 0) file.text().then((text) => previewBackup(JSON.parse(text))).catch((error) => setBackupMessage(String(error)));
													}
												})
											]
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: Market_module_css_default.backupCard,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("webdav") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
											open: presetOpen,
											onClose: () => setPresetOpen(false),
											onSelect: (id) => {
												const urls = {
													jianguoyun: "https://dav.jianguoyun.com/dav/dsh-profile-backup.json",
													koofr: "https://app.koofr.net/dav/Koofr/dsh-profile-backup.json",
													nextcloud: "https://nextcloud.example/remote.php/dav/files/USERNAME/dsh-profile-backup.json"
												};
												if (urls[id] !== void 0) setWebdavUrl(urls[id]);
											},
											align: "start",
											anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }),
												onClick: () => setPresetOpen((o) => !o),
												children: t("webdavPreset")
											}),
											items: [
												{
													id: "custom",
													label: t("webdavPreset")
												},
												{
													id: "jianguoyun",
													label: "坚果云 / Nutstore"
												},
												{
													id: "koofr",
													label: "Koofr"
												},
												{
													id: "nextcloud",
													label: "Nextcloud"
												}
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.backupInput,
											icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline14, { size: 14 }),
											type: "url",
											value: webdavUrl,
											placeholder: t("webdavUrl"),
											onChange: (e) => setWebdavUrl(e.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.backupInput,
											autoComplete: "username",
											value: webdavUser,
											placeholder: t("webdavUser"),
											onChange: (e) => setWebdavUser(e.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.backupInput,
											type: "password",
											autoComplete: "current-password",
											value: webdavPassword,
											placeholder: t("webdavPassword"),
											onChange: (e) => setWebdavPassword(e.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: Market_module_css_default.backupActions,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "primary",
												size: "sm",
												disabled: backupBusy || webdavUrl.trim() === "",
												onClick: () => runWebdav("backup"),
												children: backupBusy ? t("backupWorking") : t("webdavUpload")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												disabled: backupBusy || webdavUrl.trim() === "",
												onClick: () => runWebdav("restore"),
												children: t("webdavRestore")
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: Market_module_css_default.backupCheck,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: autoBackup,
												onChange: (e) => setAutoBackup(e.target.checked)
											}), t("autoBackup")]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("webdavNote") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: Market_module_css_default.backupWarn,
											children: t("credsWarning")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: Market_module_css_default.backupCard,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: t("gist") }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.backupInput,
											type: "password",
											autoComplete: "off",
											value: gistToken,
											placeholder: t("gistToken"),
											onChange: (e) => setGistToken(e.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.backupInput,
											icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLinkOutline14, { size: 14 }),
											value: gistId,
											placeholder: t("gistId"),
											onChange: (e) => setGistId(e.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: Market_module_css_default.backupActions,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: Market_module_css_default.backupCheck,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "radio",
													name: "gist-mode",
													checked: gistMode === "update",
													onChange: () => setGistMode("update")
												}), t("gistModeUpdate")]
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: Market_module_css_default.backupCheck,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "radio",
													name: "gist-mode",
													checked: gistMode === "create",
													onChange: () => setGistMode("create")
												}), t("gistModeCreate")]
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: Market_module_css_default.backupActions,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "outline",
													size: "sm",
													disabled: gistBusy,
													onClick: () => runGist("verify"),
													children: gistBusy ? t("backupWorking") : t("gistVerify")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "primary",
													size: "sm",
													disabled: gistBusy || gistMode === "update" && gistId.trim() === "",
													onClick: openExportPicker,
													children: gistBusy ? t("backupWorking") : t("gistExport")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "outline",
													size: "sm",
													disabled: gistBusy || gistId.trim() === "",
													onClick: () => runGist("import"),
													children: t("gistImport")
												})
											]
										}),
										gistResult !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: Market_module_css_default.backupCheck,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("gistCreated") }),
												" ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
													className: Market_module_css_default.src,
													href: gistResult.gistUrl,
													target: "_blank",
													rel: "noreferrer",
													children: gistResult.gistUrl
												})
											]
										}),
										gistMessage !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: gistOk ? Market_module_css_default.backupMessage : Market_module_css_default.backupWarn,
											children: gistMessage
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("gistNote") })
									]
								})
							]
						}) : tab === "discover" ? loadError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.empty,
							children: t("loadFail")
						}) : data === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.loading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: Market_module_css_default.spin,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 22 })
							}), t("loading")]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.tabSearchRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: Market_module_css_default.tabSearch,
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
									placeholder: t("searchPh"),
									value: q,
									onChange: (e) => setQ(e.target.value)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.cats,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.catsRow,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										ref: catsWrapRef,
										className: catsOpen || visibleCats === null ? `${Market_module_css_default.catsWrap} ${Market_module_css_default.catsCollapsed}` : Market_module_css_default.catsWrap,
										children: (() => {
											const ordered = orderedCategories(categories, cat, catsOpen);
											const shown = catsOpen || visibleCats === null ? ordered : ordered.slice(0, Math.max(0, visibleCats - 1));
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
													"data-chip": "1",
													active: cat === "all",
													onClick: () => setCat("all"),
													children: t("all")
												}),
												shown.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Pill, {
													"data-chip": "1",
													active: cat === id,
													onClick: () => setCat(id),
													children: data.categories[id] && (data.categories[id][lang] || data.categories[id].en) || id
												}, id)),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
													variant: "ghost",
													size: "sm",
													className: Market_module_css_default.catsToggle,
													icon: catsOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }),
													"aria-label": catsOpen ? t("catsLess") : t("catsMore"),
													onClick: () => setCatsOpen((o) => !o)
												})
											] });
										})()
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
										open: filterOpen,
										onClose: () => setFilterOpen(false),
										onSelect: onFilterSelect,
										selectedIds: filterSelectedIds,
										align: "end",
										portal: true,
										anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											icon: filterOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }),
											onClick: () => setFilterOpen((o) => !o),
											children: t("filter")
										}),
										items: filterItems
									})]
								})
							}),
							plugins.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.empty,
								children: t("empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.grid,
								children: pagePlugins.map(pluginCard)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.pager,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.pagerPages,
									children: totalPages > 1 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: currentPage === 1,
											onClick: () => goToPage(1),
											"aria-label": t("firstPage"),
											children: "«"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutline14, { size: 14 }),
											disabled: currentPage === 1,
											onClick: () => goToPage(currentPage - 1),
											children: t("prevPage")
										}),
										pageItems(currentPage, totalPages).map((item, i) => item === "…" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.pageEllipsis,
											children: "…"
										}, "e" + i) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: item === currentPage ? "primary" : "outline",
											size: "sm",
											onClick: () => goToPage(item),
											children: item
										}, item)),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: currentPage === totalPages,
											onClick: () => goToPage(currentPage + 1),
											children: [t("nextPage"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronRightOutline14, { size: 14 })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											disabled: currentPage === totalPages,
											onClick: () => goToPage(totalPages),
											"aria-label": t("lastPage"),
											children: "»"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.pageInfo,
											children: t("pageInfo").replace("{0}", String(currentPage)).replace("{1}", String(totalPages))
										})
									] })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
									open: sizeOpen,
									onClose: () => setSizeOpen(false),
									onSelect: (id) => changePageSize(Number(id)),
									selectedId: String(pageSize),
									align: "end",
									portal: true,
									anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 }),
										onClick: () => setSizeOpen((o) => !o),
										children: t("perPage") + " " + pageSize
									}),
									items: PAGE_SIZES.map((size) => ({
										id: String(size),
										label: String(size)
									}))
								})]
							})] })
						] }) : tab === "themes" && themeSnap !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.tabSearchRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: Market_module_css_default.tabSearch,
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
									placeholder: t("searchPh"),
									value: qThemes,
									onChange: (e) => setQThemes(e.target.value)
								})
							}),
							(() => {
								const extra = themeSnap.themes.filter((def) => def.id !== "light" && def.id !== "dark");
								return extra.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: `${Market_module_css_default.grid} ${Market_module_css_default.themesGrid}`,
									children: extra.map((def) => themeCard(def.id, def.id, themeSwatch(def)))
								});
							})(),
							data === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.loading,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.spin,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 22 })
								}), t("loading")]
							}) : themePlugins$1.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.empty,
								children: t("themeEmpty")
							}) : filteredThemePlugins.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.empty,
								children: t("empty")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.grid,
								children: filteredThemePlugins.map(themePluginCard)
							})
						] }) : tab === "diagnostics" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Diagnostics, { t }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.viewBar,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: installedView === "list" ? `${Market_module_css_default.viewBtn} ${Market_module_css_default.viewOn}` : Market_module_css_default.viewBtn,
									onClick: () => setInstalledView("list"),
									children: t("tabList")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: installedView === "groups" ? `${Market_module_css_default.viewBtn} ${Market_module_css_default.viewOn}` : Market_module_css_default.viewBtn,
									onClick: () => setInstalledView("groups"),
									children: t("tabGroups")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.tabSearchRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
									className: Market_module_css_default.tabSearch,
									icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
									placeholder: t("searchPh"),
									value: qInstalled,
									onChange: (e) => setQInstalled(e.target.value)
								})
							}),
							installedView === "groups" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.groupCreate,
									children: creatingGroup ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: Market_module_css_default.inlineInput,
											placeholder: t("groupNamePh"),
											value: newGroupName,
											onChange: (e) => setNewGroupName(e.target.value),
											onKeyDown: (e) => {
												if (e.key === "Enter") doCreateGroup();
											},
											autoFocus: true
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "primary",
											size: "sm",
											onClick: doCreateGroup,
											children: t("groupCreate")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "ghost",
											size: "sm",
											onClick: () => {
												setCreatingGroup(false);
												setNewGroupName("");
											},
											children: t("cancel")
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										onClick: () => setCreatingGroup(true),
										children: t("groupNew")
									})
								}),
								groupOrder.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.empty,
									children: t("noGroups")
								}) : groupOrder.map((gid) => {
									const members = groups[gid] ?? [];
									const sw = groupSwitchState(members, effectiveDisabledSet);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.groupRow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.groupHead,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														role: "switch",
														"aria-checked": sw === "on" ? true : sw === "off" ? false : "mixed",
														"aria-label": (sw !== "on" ? t("enable") : t("disable")) + " " + gid,
														className: sw === "on" ? `${Market_module_css_default.switch} ${Market_module_css_default.switchOn}` : sw === "mixed" ? `${Market_module_css_default.switch} ${Market_module_css_default.switchMixed}` : Market_module_css_default.switch,
														disabled: togglingName !== null || sw === "empty",
														onClick: () => doGroupToggle(gid, sw !== "on"),
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.switchKnob })
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: Market_module_css_default.groupName,
														children: gid
													}),
													sw === "mixed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: Market_module_css_default.groupHint,
														children: t("groupMixed")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: Market_module_css_default.groupActions,
														children: [
															renamingGroup === gid ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
																	className: Market_module_css_default.inlineInput,
																	placeholder: t("groupNamePh"),
																	value: renamingValue,
																	onChange: (e) => setRenamingValue(e.target.value),
																	onKeyDown: (e) => {
																		if (e.key === "Enter") doRenameGroup(gid);
																	},
																	autoFocus: true
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																	variant: "primary",
																	size: "sm",
																	onClick: () => doRenameGroup(gid),
																	children: t("groupRename")
																}),
																/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																	variant: "ghost",
																	size: "sm",
																	onClick: () => {
																		setRenamingGroup(null);
																		setRenamingValue("");
																	},
																	children: t("cancel")
																})
															] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "ghost",
																size: "sm",
																onClick: () => {
																	setRenamingGroup(gid);
																	setRenamingValue(gid);
																},
																children: t("groupRename")
															}),
															deletingGroup === gid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "primary",
																size: "sm",
																className: Market_module_css_default.dangerArmed,
																onClick: () => doDeleteGroup(gid),
																children: t("groupConfirmDelete")
															}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "outline",
																size: "sm",
																className: Market_module_css_default.dangerBtn,
																onClick: () => setDeletingGroup(gid),
																children: t("groupDelete")
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "outline",
																size: "sm",
																onClick: () => setAddPanel(addPanel !== null && addPanel.group === gid && addPanel.kind === "plugin" ? null : {
																	group: gid,
																	kind: "plugin"
																}),
																children: t("groupAdd")
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "outline",
																size: "sm",
																disabled: members.some((member) => installedThemeNames.has(member)),
																onClick: () => setAddPanel(addPanel !== null && addPanel.group === gid && addPanel.kind === "theme" ? null : {
																	group: gid,
																	kind: "theme"
																}),
																children: t("groupAddTheme")
															})
														]
													})
												]
											}),
											addPanel !== null && addPanel.group === gid && (() => {
												const candidates = addPanel.kind === "theme" ? [...installedThemeNames].filter((name) => !members.includes(name)) : groupableNames.filter((name) => !members.includes(name) && !installedThemeNames.has(name));
												return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.groupAddPanel,
													children: candidates.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: Market_module_css_default.groupHint,
														children: t("groupAddEmpty")
													}) : candidates.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: Market_module_css_default.groupMember,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: Market_module_css_default.nm,
																children: name
															}),
															effectiveDisabledSet.has(name) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: Market_module_css_default.spec,
																children: t("disabledState")
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																variant: "outline",
																size: "sm",
																onClick: () => doAddMember(gid, name),
																children: addPanel.kind === "theme" ? t("groupAddTheme") : t("groupAdd")
															})
														]
													}, name))
												});
											})(),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.groupMembers,
												children: [members.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.groupHint,
													children: t("groupEmpty")
												}), members.map((member) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: Market_module_css_default.groupMember,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.nm,
															children: member
														}),
														effectiveDisabledSet.has(member) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.spec,
															children: t("disabledState")
														}),
														patchDisabledNames.includes(member) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.spec,
															children: " · " + t("patchDisabled")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															role: "switch",
															"aria-checked": !effectiveDisabledSet.has(member),
															"aria-label": (effectiveDisabledSet.has(member) ? t("enable") : t("disable")) + " " + member,
															className: effectiveDisabledSet.has(member) ? Market_module_css_default.switch : `${Market_module_css_default.switch} ${Market_module_css_default.switchOn}`,
															disabled: togglingName !== null,
															onClick: () => doToggle(member, effectiveDisabledSet.has(member)),
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.switchKnob })
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
															variant: "ghost",
															size: "sm",
															onClick: () => doRemoveMember(gid, member),
															children: t("groupRemove")
														})
													]
												}, member))]
											})
										]
									}, gid);
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.sect,
									children: t("ungrouped")
								}),
								ungroupedNames.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.empty,
									children: t("installedEmpty")
								}) : ungroupedNames.map((name) => {
									const entry = data === null ? void 0 : entryForDep(data.plugins, name, String(installed[name]));
									const off = effectiveDisabledSet.has(name);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.irow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: { minWidth: 0 },
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: Market_module_css_default.nm,
													children: [
														name,
														entry?.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.depBadge,
															children: t("deprecatedBadge")
														}),
														patchDisabledNames.includes(name) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.depBadge,
															children: t("patchDisabled")
														})
													]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.act,
													children: off ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: Market_module_css_default.actWarn,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
															state: "warning",
															size: 7
														}), t("disabledState")]
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: Market_module_css_default.actLive,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
															state: "done",
															size: 7
														}), t("stateLive")]
													})
												})]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
											assignFor === name ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.assignRow,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
														className: Market_module_css_default.assignSelect,
														value: assignTarget,
														onChange: (e) => setAssignTarget(e.target.value),
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: t("groupNamePh")
														}), groupOrder.map((gid) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: gid,
															children: gid
														}, gid))]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
														variant: "primary",
														size: "sm",
														disabled: assignTarget === "",
														onClick: () => doAssign(name),
														children: t("groupAssign")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
														variant: "ghost",
														size: "sm",
														onClick: () => {
															setAssignFor(null);
															setAssignTarget("");
														},
														children: t("cancel")
													})
												]
											}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												disabled: groupOrder.length === 0,
												onClick: () => {
													setAssignFor(name);
													setAssignTarget("");
												},
												children: t("groupAssign")
											})
										]
									}, "ug-" + name);
								})
							] }) : Object.keys(displayedInstalled).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.empty,
								children: t("installedEmpty")
							}) : Object.entries(displayedInstalled).filter(([name, spec]) => {
								const needle = qInstalled.trim().toLowerCase();
								if (needle === "") return true;
								if (name.toLowerCase().includes(needle)) return true;
								if (String(spec).toLowerCase().includes(needle)) return true;
								const entry = data === null ? void 0 : entryForDep(data.plugins, name, String(spec));
								if (entry !== void 0) {
									if ((entry.description && (entry.description[lang] || entry.description.en) || "").toLowerCase().includes(needle)) return true;
									if ((entry.owner || "").toLowerCase().includes(needle)) return true;
								}
								return false;
							}).map(([name, spec]) => {
								const missing = pendingBackup !== null && !installedFiles.includes(name);
								const entry = data === null ? void 0 : entryForDep(data.plugins, name, String(spec));
								const status = updates[name];
								const act = activations[name];
								const meta = act !== void 0 ? activationMeta(act.state, t) : null;
								const version = status && status.version ? "v" + status.version : "";
								const specText = String(spec);
								const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText);
								const repoUrl = entry !== void 0 ? entry.url : ghSpec !== null ? "https://github.com/" + ghSpec[1] : null;
								const off = effectiveDisabledSet.has(name);
								const toggleable = off || act !== void 0 && (act.state === "live" || act.state === "restart");
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: missing ? `${Market_module_css_default.irow} ${Market_module_css_default.irowMissing}` : Market_module_css_default.irow,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: { minWidth: 0 },
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: Market_module_css_default.nm,
													children: [
														name,
														entry?.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.depBadge,
															children: t("deprecatedBadge")
														}),
														patchDisabledNames.includes(name) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.depBadge,
															children: t("patchDisabled")
														}),
														!effectiveDisabledSet.has(name) && patchForcedNames.includes(name) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.depBadge,
															children: t("patchForced")
														}),
														version && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.owner,
															children: " " + version
														})
													]
												}),
												repoUrl !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
													className: `${Market_module_css_default.spec} ${Market_module_css_default.src}`,
													href: repoUrl,
													target: "_blank",
													rel: "noreferrer",
													style: { display: "inline-block" },
													children: specText
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.spec,
													children: specText
												}),
												entry !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: `${Market_module_css_default.desc} ${Market_module_css_default.descTight}`,
													children: entry.description && (entry.description[lang] || entry.description.en) || ""
												}),
												off ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.act,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: Market_module_css_default.actWarn,
														children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
																state: "warning",
																size: 7
															}),
															t("disabledState"),
															patchDisabledNames.includes(name) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
																className: Market_module_css_default.spec,
																children: " · " + t("patchDisabled")
															})
														]
													})
												}) : act !== void 0 && meta !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: Market_module_css_default.act,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: meta.dot === "done" ? Market_module_css_default.actLive : meta.dot === "error" ? Market_module_css_default.actBroken : Market_module_css_default.actWarn,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
															state: meta.dot,
															size: 7
														}), meta.label]
													}), act.state !== "live" && act.reasons.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
														icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconQuestionOutline14, { size: 14 }),
														title: t("actWhy"),
														open: whyOpen === name,
														expandable: true,
														onToggle: () => setWhyOpen(whyOpen === name ? null : name),
														className: Market_module_css_default.actWhy,
														children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: Market_module_css_default.spec,
															children: act.reasons.join(" / ")
														})
													})]
												}),
												entry !== void 0 && entry.deprecated === true && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.deprecate,
													style: { marginTop: 8 },
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
														className: Market_module_css_default.depLine,
														children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚠️ ", t("deprecatedWarn")] }), entry.replacement !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.src,
															children: t("replacementHint") + " " + entry.replacement
														})]
													})
												}),
												updatingName === name && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: Market_module_css_default.progress,
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: Market_module_css_default.spin,
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconLoadingOutline16, { size: 14 })
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
															className: Market_module_css_default.grow,
															children: progressText
														}),
														progressPct !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
															className: Market_module_css_default.pct,
															children: [progressPct, "%"]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
															variant: "outline",
															size: "sm",
															disabled: cancelling,
															onClick: doCancel,
															children: cancelling ? t("cancelling") : t("cancelOp")
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
															className: Market_module_css_default.bar,
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
																className: progressPct !== null ? Market_module_css_default.barFill : `${Market_module_css_default.barFill} ${Market_module_css_default.barWave}`,
																style: progressPct !== null ? { width: `${progressPct}%` } : void 0
															})
														})
													]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
										toggleable && (name === "dsh-market" || name === "dshmarket" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
											label: t("marketNoToggle"),
											side: "top",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												role: "switch",
												"aria-checked": true,
												"aria-label": t("marketNoToggle"),
												className: `${Market_module_css_default.switch} ${Market_module_css_default.switchOn}`,
												disabled: true,
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.switchKnob })
											}) })
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											role: "switch",
											"aria-checked": !off,
											"aria-label": (off ? t("enable") : t("disable")) + " " + name,
											className: off ? Market_module_css_default.switch : `${Market_module_css_default.switch} ${Market_module_css_default.switchOn}`,
											disabled: togglingName !== null || busyUrl !== null || updatingName !== null || removingName !== null,
											onClick: () => doToggle(name, off),
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.switchKnob })
										})),
										repoUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
											className: Market_module_css_default.src,
											href: repoUrl + "#readme",
											target: "_blank",
											rel: "noreferrer",
											children: t("readme")
										}),
										entry !== void 0 && entry.deprecated === true && entry.replacement !== void 0 && (() => {
											const replacement = data?.plugins.find((r) => r.name === entry.replacement);
											if (replacement === void 0) return null;
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												onClick: () => {
													setCat("all");
													setQ(entry.replacement);
													setTab("discover");
												},
												children: t("viewReplacement")
											}), !isInstalled(replacement, installed) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
												variant: "outline",
												size: "sm",
												onClick: () => setConfirming(replacement),
												children: t("installReplacement")
											})] });
										})(),
										missing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.owner,
											children: t("notInstalled")
										}) : updatedNames.includes(name) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.okState,
											children: act?.state === "live" ? t("updatedLive") : t("updated")
										}) : updatingName === name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "primary",
											size: "sm",
											className: Market_module_css_default.warnBtn,
											disabled: true,
											children: t("updating")
										}) : status && status.updateAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "primary",
											size: "sm",
											className: Market_module_css_default.warnBtn,
											disabled: updatingName !== null,
											onClick: () => doUpdate(name),
											children: t("update")
										}) : status && status.kind === "linked" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.owner,
											children: t("linkedDev")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.owner,
											children: t("upToDate")
										}),
										!missing && name !== "dsh-market" && name !== "dshmarket" && (removingName === name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											className: Market_module_css_default.dangerBtn,
											disabled: true,
											children: t("uninstalling")
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
											variant: "outline",
											size: "sm",
											className: Market_module_css_default.dangerBtn,
											disabled: removingName !== null || busyUrl !== null || updatingName !== null,
											onClick: () => setRemoveConfirm(name),
											children: t("uninstall")
										}))
									]
								}, name);
							})
						] })
					}),
					showTop && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
						label: t("backTop"),
						side: "top",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: Market_module_css_default.top,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								variant: "outline",
								className: Market_module_css_default.topBtn,
								"aria-label": t("backTop"),
								onClick: () => {
									const el = bodyRef.current;
									if (el) el.scrollTo({
										top: 0,
										behavior: "smooth"
									});
								},
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { size: 16 })
							})
						})
					}),
					confirming !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => {
							setConfirming(null);
							setCmdOpen(false);
						},
						title: t("confirmTitle") + " " + confirming.name + "?",
						description: confirming.description && (confirming.description[lang] || confirming.description.en) || "",
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							onClick: () => {
								setConfirming(null);
								setCmdOpen(false);
							},
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							onClick: () => doInstall(confirming),
							children: t("confirm")
						})] }),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ScreenshotStrip, { plugin: confirming }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, { size: 16 }),
								title: t("cmdDetails"),
								open: cmdOpen,
								expandable: true,
								onToggle: () => setCmdOpen((o) => !o),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.cmd,
									children: confirming.install
								})
							}),
							looksTerminal(confirming, lang) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: Market_module_css_default.warnLine,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, {
										size: 14,
										className: Market_module_css_default.bannerIcon
									}),
									" " + t("terminalWarn") + " ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										className: Market_module_css_default.src,
										href: confirming.url + "#readme",
										target: "_blank",
										rel: "noreferrer",
										children: t("readme")
									})
								]
							}),
							confirming.deprecated === true && (() => {
								const replacement = replacementOf(confirming);
								return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.deprecate,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.depLine,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["⚠️ ", t("deprecatedWarn")] }), replacement !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
											className: Market_module_css_default.src,
											href: replacement.url,
											target: "_blank",
											rel: "noreferrer",
											children: t("replacementHint") + " " + replacement.name
										})]
									})
								});
							})(),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: Market_module_css_default.modalNote,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, {
									size: 14,
									className: Market_module_css_default.bannerIcon
								}), " " + t("confirmWarn")]
							})
						]
					}),
					removeConfirm !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setRemoveConfirm(null),
						title: t("uninstall") + " " + removeConfirm + "?",
						description: t("uninstallConfirmDesc"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							onClick: () => setRemoveConfirm(null),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: removingName !== null,
							onClick: () => doUninstall(removeConfirm),
							children: t("uninstall")
						})] })
					}),
					restoreConfirmOpen && pendingBackup !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setRestoreConfirmOpen(false),
						title: t("restoreConfirm"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							onClick: () => setRestoreConfirmOpen(false),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: backupBusy,
							onClick: doRestore,
							children: t("confirm")
						})] })
					}),
					exportOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setExportOpen(false),
						title: t("gistExportSelect"),
						description: t("gistExportHint"),
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							onClick: () => setExportOpen(false),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: gistBusy || exportSelection.size === 0,
							onClick: () => runGist("export"),
							children: gistBusy ? t("backupWorking") : t("gistExportGo")
						})] }),
						children: [exportOptions.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("gistNoPlugins") }), exportOptions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.backupActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									onClick: () => setExportSelection(new Set(exportOptions)),
									children: t("gistSelectAll")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									size: "sm",
									variant: "outline",
									onClick: () => setExportSelection(/* @__PURE__ */ new Set()),
									children: t("gistSelectNone")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: Market_module_css_default.backupCheckList,
								children: exportOptions.map((name) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: Market_module_css_default.backupCheck,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: exportSelection.has(name),
											onChange: (e) => {
												const next = new Set(exportSelection);
												if (e.currentTarget.checked) next.add(name);
												else next.delete(name);
												setExportSelection(next);
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.grow,
											children: name
										}),
										specKind(installed[name]) === "git" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${Market_module_css_default.specTag} ${Market_module_css_default.specTagGit}`,
											children: "git"
										}),
										specKind(installed[name]) === "file" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${Market_module_css_default.specTag} ${Market_module_css_default.specTagFile}`,
											children: t("gistSpecLocal")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: Market_module_css_default.spec,
											title: installed[name],
											children: installed[name] ?? t("bundleTag")
										})
									]
								}, name))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: Market_module_css_default.backupCheck,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: exportIncludeConfig,
									onChange: (e) => setExportIncludeConfig(e.target.checked)
								}), t("gistIncludeConfig")]
							}),
							exportIncludeConfig && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: Market_module_css_default.backupWarn,
								children: t("credsWarning")
							}),
							exportError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: Market_module_css_default.backupWarn,
								children: exportError
							})
						] })]
					}),
					exportState === "done" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: t("exportedLog"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 }),
						onDone: exportToastDone
					}),
					exportState === "fail" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
						text: t("exportLogFail"),
						icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconWarningOutline16, { size: 14 }),
						onDone: exportToastDone
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-market client: registers a "Market" settings section rendering the
		* plugin market UI, plus the post-install toast in the shell overlay layer.
		* Built by tsdown into the __ModuleLoader__ factory bundle at
		* client/client.js; the only externals are the loader module table's react
		* entries.
		*/
		const NS = "dsh-market";
		/**
		* Primitives this bundle relies on that did not exist before rc.6. The
		* primitives module is host-injected (external at build time), so on an
		* older host the module resolves but these named exports are undefined —
		* rendering would throw and blank the whole settings dialog. Returning the
		* gaps lets apply() skip registration for a clean downgrade instead.
		*/
		const REQUIRED_PRIMITIVES = [
			"Menu",
			"DisclosureRow",
			"Tooltip",
			"Toast"
		];
		function missingPrimitives(mod, required = REQUIRED_PRIMITIVES) {
			return required.filter((name) => mod[name] === void 0);
		}
		const name = "dsh-market";
		const inject = [
			"slots",
			"locale",
			"theme"
		];
		function apply(ctx) {
			const gaps = missingPrimitives(_deepseek_ai_dsh_client_ui_primitives);
			if (gaps.length > 0) {
				console.warn("[dsh-market] host ui-primitives missing " + gaps.join(", ") + " — market section disabled (dsh web >= 0.1.0-rc.6 required)");
				return;
			}
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-market: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "market",
				order: 40,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ t })
			}, () => (0, react.createElement)(MarketSection, {
				t,
				locale: ctx.locale,
				theme: ctx.theme,
				themeStore: {
					subscribe: (cb) => ctx.on("theme/change", cb),
					getSnapshot: () => ctx.theme.getTheme()
				}
			})));
			const Toast = () => (0, react.createElement)(InstallToast, { t });
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-market-toast",
				label: () => "dsh-market"
			}, Toast));
		}
		//#endregion
		exports.REQUIRED_PRIMITIVES = REQUIRED_PRIMITIVES;
		exports.apply = apply;
		exports.inject = inject;
		exports.missingPrimitives = missingPrimitives;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map