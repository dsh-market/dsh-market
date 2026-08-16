window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => {


		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
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
			restarting: "正在重启…",
			restartFail: "重启失败",
			restartTimeout: "等待 DeepSeek Harness 启动超时",
			updateNow: "立即更新",
			updateFail: "更新失败",
			upToDate: "已是最新",
			linkedDev: "本地开发链接",
			exportLog: "导出日志",
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
			themeApply: "使用",
			themeActive: "使用中",
			themeEmpty: "目录里暂时还没有主题，敬请期待",
			progressHint: "首次安装需要下载与解析依赖，大插件可能要 1-3 分钟",
			toastReady: "已装好并已生效",
			toastTheme: "已启用。到 设置 → 插件市场 → 主题 可随时切换",
			gotIt: "知道了",
			stateLive: "已生效（热加载）",
			stateRestart: "已安装，重启后生效",
			stateInert: "已安装但未成为 profile 层",
			stateBroken: "安装完成但校验失败",
			phaseResolving: "解析依赖",
			phaseDownloading: "下载中",
			phaseLinking: "链接依赖",
			phaseBuilding: "运行构建脚本",
			cancelling: "正在取消…",
			packagesDone: "已处理 {0} 个包",
			updatedLive: "✓ 已更新，已生效",
			partialNote: "已取消，部分变更已写入",
			actWhy: "为什么未生效？"
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
			restarting: "Restarting…",
			restartFail: "Restart failed",
			restartTimeout: "Timed out waiting for DeepSeek Harness to start",
			updateNow: "Update now",
			updateFail: "Update failed",
			upToDate: "Up to date",
			linkedDev: "linked (dev)",
			exportLog: "Export log",
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
			themeApply: "Use",
			themeActive: "Active",
			themeEmpty: "No more theme plugins in the catalog yet — stay tuned",
			progressHint: "First installs download and resolve dependencies — large plugins can take 1-3 minutes",
			toastReady: "installed and live",
			toastTheme: "is now active. Switch any time in Settings → Plugin Market → Themes",
			gotIt: "Got it",
			stateLive: "Live (hot-loaded)",
			stateRestart: "Installed — restart to apply",
			stateInert: "Installed but not a profile-layer plugin",
			stateBroken: "Installed but failed validation",
			phaseResolving: "Resolving dependencies",
			phaseDownloading: "Downloading",
			phaseLinking: "Linking",
			phaseBuilding: "Running build scripts",
			cancelling: "Cancelling…",
			packagesDone: "{0} packages processed",
			updatedLive: "✓ Updated — live",
			partialNote: "Cancelled — some changes were applied",
			actWhy: "Why not live?"
		};
		//#endregion
		//#region src/client/market-data.ts
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
		/** The installed dependency name a registry entry corresponds to, or null. */
		function matchInstalledName(plugin, installed) {
			const ids = entryIdentities(plugin);
			for (const [name, spec] of Object.entries(installed)) for (const id of depIdentities(name, String(spec))) if (ids.has(id)) return name;
			return null;
		}
		/** The registry entry an installed dependency corresponds to, or undefined. */
		function entryForDep(plugins, name, spec) {
			const ids = depIdentities(name, String(spec));
			return plugins.find((plugin) => {
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
				icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "✨" }),
				onDone: () => setNames([])
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/fkysly_mini/work/dsh-market/src/client/Market.module.css.mjs
		const css = ".SOz1_a_root{min-width:0;height:100%;color:var(--dsw-alias-label-primary,#1f2328);flex-direction:column;display:flex;position:relative}.SOz1_a_head{flex-direction:column;gap:12px;padding:4px 4px 12px;display:flex}.SOz1_a_title{margin:0;font-size:16px;font-weight:500;line-height:24px}.SOz1_a_sub{color:var(--dsw-alias-label-tertiary,#8b93a1);margin:0;font-size:14px;line-height:22px}.SOz1_a_searchInline{flex-shrink:0;width:200px;margin-bottom:6px}.SOz1_a_tabs{border-bottom:1px solid var(--dsw-alias-border-l2,#e5e7eb);align-items:flex-end;gap:2px;display:flex}.SOz1_a_tab{font:inherit;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-bottom:2px solid #0000;padding:7px 12px;font-size:13px}.SOz1_a_tab.SOz1_a_on{color:var(--dsw-alias-brand-primary,#4f6ef7);border-bottom-color:var(--dsw-alias-brand-primary,#4f6ef7);font-weight:600}.SOz1_a_restart{background:var(--dsw-alias-bg-layer-2,#fdf3e3);border:1px solid var(--dsw-alias-border-l2,#f3e3c3);border-radius:8px;align-items:center;gap:8px;margin:0;padding:8px 12px;font-size:12px;display:flex}.SOz1_a_body{flex:1;padding:12px 4px 24px;overflow-x:hidden;overflow-y:auto}.SOz1_a_cats{z-index:5;background:var(--dsw-alias-bg-layer-2,#f7f8fa);margin:-12px -4px 2px;padding:12px 4px 4px;position:sticky;top:-13px}.SOz1_a_catsRow{align-items:flex-start;gap:8px;display:flex;position:relative}.SOz1_a_filterWrap{flex-shrink:0;position:relative}.SOz1_a_filterBtn{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;cursor:pointer;white-space:nowrap;border-radius:8px;align-items:center;gap:5px;padding:5px 11px;font-size:12px;line-height:18px;display:flex}.SOz1_a_filterBtn:hover,.SOz1_a_filterBtnOn{color:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_filterPanel{z-index:30;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;flex-direction:column;gap:10px;width:250px;padding:8px;display:flex;position:absolute;top:calc(100% + 6px);right:0;box-shadow:0 8px 28px #00000024}.SOz1_a_filterGroup{flex-direction:column;gap:2px;display:flex}.SOz1_a_filterTitle{color:var(--dsw-alias-label-secondary,#6b7280);padding:4px 8px 2px;font-size:11px;font-weight:600}.SOz1_a_filterOption{cursor:pointer;color:var(--dsw-alias-label-primary,#1f2328);border-radius:6px;align-items:center;gap:8px;padding:5px 8px;font-size:12px;line-height:18px;display:flex}.SOz1_a_filterOption:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}.SOz1_a_filterOption input{margin:0}.SOz1_a_star{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}.SOz1_a_top{z-index:20;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);width:38px;height:38px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;border-radius:99px;font-size:16px;position:absolute;bottom:18px;right:18px;box-shadow:0 4px 14px #0000001f}.SOz1_a_top:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_tag{border:1px solid var(--dsw-alias-border-l3,#d9dde3);color:var(--dsw-alias-label-secondary,#6b7280);border-radius:4px;flex-shrink:0;padding:1px 6px;font-size:11px;line-height:16px}.SOz1_a_okState{color:var(--dsw-alias-state-success-primary,#16a34a);white-space:nowrap;font-size:12px;font-weight:600}.SOz1_a_dangerBtn.SOz1_a_dangerBtn{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}.SOz1_a_dangerArmed.SOz1_a_dangerArmed{background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff}.SOz1_a_warnBtn.SOz1_a_warnBtn{background:var(--dsw-alias-state-warn-primary,#ea580c);color:#fff}.SOz1_a_catsWrap{flex-wrap:wrap;flex:1;align-items:center;gap:6px;min-width:0;display:flex}.SOz1_a_catsCollapsed{max-height:62px;overflow:hidden}.SOz1_a_catsToggle.SOz1_a_catsToggle{height:26px;min-height:26px;color:var(--dsw-alias-label-secondary,#6b7280);padding:0 6px}.SOz1_a_cmdDetails{margin:0}.SOz1_a_cmdSummary{cursor:pointer;width:fit-content;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:6px;align-items:center;gap:6px;margin-left:-4px;padding:2px 4px;font-size:12px;font-weight:500;line-height:18px;list-style:none;display:flex}.SOz1_a_cmdSummary::-webkit-details-marker{display:none}.SOz1_a_cmdSummary:before{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;width:5px;height:5px;transition:transform .12s;transform:rotate(-45deg)translate(-1px,-1px)}.SOz1_a_cmdDetails[open]>.SOz1_a_cmdSummary:before{transform:rotate(45deg)translate(-1px,-1px)}.SOz1_a_cmdSummary:hover{color:var(--dsw-alias-label-primary,#1f2328)}.SOz1_a_cmd{background:var(--dsw-alias-bg-layer-2,#f3f4f6);word-break:break-all;border-radius:6px;margin:8px 0 0;padding:8px 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:18px}.SOz1_a_warnLine{color:var(--dsw-alias-state-warn-primary,#b45309);margin:0;font-size:12px;font-weight:600;line-height:18px}.SOz1_a_modalNote{color:var(--dsw-alias-label-tertiary,#8b93a1);margin:12px 0 0;font-size:12px;line-height:18px}.SOz1_a_grid{grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;display:grid}.SOz1_a_sect{color:var(--dsw-alias-label-secondary,#6b7280);margin:14px 2px 8px;font-size:12px;font-weight:600}.SOz1_a_sect:first-child{margin-top:2px}.SOz1_a_swatches{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;gap:0;height:34px;display:flex;overflow:hidden}.SOz1_a_themesGrid{margin-bottom:12px}.SOz1_a_swatches i{flex:1}.SOz1_a_card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;flex-direction:column;gap:12px;padding:12px 14px;display:flex}.SOz1_a_row1{align-items:center;gap:10px;min-width:0;display:flex}.SOz1_a_av{color:#fff;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border-radius:8px;flex-shrink:0;place-items:center;width:32px;height:32px;font-size:14px;font-weight:700;display:grid}.SOz1_a_nm{text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:22px;overflow:hidden}.SOz1_a_owner{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}.SOz1_a_desc{color:var(--dsw-alias-label-tertiary,#8b93a1);min-height:36px;margin:0;font-size:12px;line-height:18px}.SOz1_a_foot{align-items:center;gap:8px;margin-top:auto;display:flex}.SOz1_a_grow{flex:1}.SOz1_a_titleRow{align-items:center;gap:10px;display:flex}.SOz1_a_descTight{min-height:0}.SOz1_a_src{color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px;text-decoration:none}.SOz1_a_src:hover{color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_dot{vertical-align:2px;margin-left:5px}.SOz1_a_act{flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;font-size:11px;display:flex}.SOz1_a_actLive{color:var(--dsw-alias-state-success-primary,#16a34a);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actWarn{color:var(--dsw-alias-state-warn-primary,#b45309);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actBroken{color:var(--dsw-alias-state-error-primary,#dc2626);align-items:center;gap:4px;font-weight:600;display:inline-flex}.SOz1_a_actWhy{margin:0}.SOz1_a_actWhy summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px}.SOz1_a_loading{color:var(--dsw-alias-label-secondary,#9ca3af);flex-direction:column;align-items:center;gap:12px;padding:48px;font-size:13px;display:flex}.SOz1_a_spin{border:3px solid var(--dsw-alias-border-l1,#e5e7eb);border-top-color:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;width:22px;height:22px;animation:.8s linear infinite SOz1_a_sp}@keyframes SOz1_a_sp{to{transform:rotate(360deg)}}.SOz1_a_progress{background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);color:var(--dsw-alias-label-secondary,#6b7280);border-radius:8px;flex-wrap:wrap;align-items:center;gap:9px;margin:0;padding:8px 12px;font-size:12px;display:flex}.SOz1_a_bar{background:var(--dsw-alias-border-l1,#e5e7eb);border-radius:99px;width:100%;height:4px;overflow:hidden}.SOz1_a_barFill{background:var(--dsw-alias-brand-primary,#4f6ef7);border-radius:99px;height:100%;transition:width .6s}.SOz1_a_barWave{width:30%;animation:1.2s ease-in-out infinite SOz1_a_dshmSlide}@keyframes SOz1_a_dshmSlide{0%{margin-left:-30%}to{margin-left:100%}}.SOz1_a_irow .SOz1_a_progress{margin-top:8px}.SOz1_a_progress .SOz1_a_spin{border-width:2px;flex-shrink:0;width:14px;height:14px}.SOz1_a_progress code{text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace;font-size:11px;overflow:hidden}.SOz1_a_empty{color:var(--dsw-alias-label-secondary,#9ca3af);text-align:center;padding:32px;font-size:13px}.SOz1_a_err{color:var(--dsw-alias-state-error-primary,#dc2626);white-space:pre-wrap;word-break:break-all;margin:8px 0;font-size:12px}.SOz1_a_irow{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:12px;align-items:center;gap:10px;margin-bottom:8px;padding:12px 14px;display:flex}.SOz1_a_irow>.SOz1_a_src,.SOz1_a_irow>.SOz1_a_owner,.SOz1_a_dangerBtn.SOz1_a_dangerBtn,.SOz1_a_warnBtn.SOz1_a_warnBtn,.SOz1_a_dangerArmed.SOz1_a_dangerArmed{white-space:nowrap;flex-shrink:0}.SOz1_a_spec{color:var(--dsw-alias-label-secondary,#9ca3af);font-family:ui-monospace,Menlo,monospace;font-size:11px}.SOz1_a_staleAction{margin-top:8px}.SOz1_a_pct{color:var(--dsw-alias-label-secondary,#6b7280);flex-shrink:0;font-size:11px;font-weight:600}.SOz1_a_cancelBtn{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;cursor:pointer;white-space:nowrap;border-radius:6px;flex-shrink:0;padding:2px 10px;font-size:11px;line-height:16px}.SOz1_a_cancelBtn:hover{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:var(--dsw-alias-state-error-primary,#dc2626)}.SOz1_a_pager{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin:16px 0 4px;display:flex}.SOz1_a_pagerPages{flex-wrap:wrap;flex:1;justify-content:center;align-items:center;gap:6px;min-width:0;display:flex}.SOz1_a_pagerSize{flex-shrink:0;align-items:center;gap:4px;display:flex}.SOz1_a_sizeLabel{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px}.SOz1_a_sizeBtn{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;cursor:pointer;border-radius:6px;padding:3px 8px;font-size:12px;line-height:18px}.SOz1_a_sizeBtn:hover{color:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_sizeOn{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-weight:600}.SOz1_a_pageBtn{border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;cursor:pointer;border-radius:6px;min-width:28px;padding:4px 10px;font-size:12px;line-height:18px}.SOz1_a_pageBtn:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7)}.SOz1_a_pageBtn:disabled{opacity:.45;cursor:default}.SOz1_a_pageOn{background:var(--dsw-alias-brand-primary,#4f6ef7);border-color:var(--dsw-alias-brand-primary,#4f6ef7);color:#fff;font-weight:600}.SOz1_a_pageEllipsis{color:var(--dsw-alias-label-secondary,#9ca3af);padding:0 2px;font-size:12px}.SOz1_a_pageInfo{color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;font-size:12px}";
		const tagId = "dshmarket/Market.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dshmarket";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var Market_module_css_default = {
			"restart": "SOz1_a_restart",
			"cmdSummary": "SOz1_a_cmdSummary",
			"actLive": "SOz1_a_actLive",
			"tabs": "SOz1_a_tabs",
			"filterPanel": "SOz1_a_filterPanel",
			"dangerArmed": "SOz1_a_dangerArmed",
			"owner": "SOz1_a_owner",
			"catsToggle": "SOz1_a_catsToggle",
			"sp": "SOz1_a_sp",
			"root": "SOz1_a_root",
			"empty": "SOz1_a_empty",
			"staleAction": "SOz1_a_staleAction",
			"actWhy": "SOz1_a_actWhy",
			"swatches": "SOz1_a_swatches",
			"cats": "SOz1_a_cats",
			"body": "SOz1_a_body",
			"sect": "SOz1_a_sect",
			"foot": "SOz1_a_foot",
			"spin": "SOz1_a_spin",
			"bar": "SOz1_a_bar",
			"pct": "SOz1_a_pct",
			"sizeLabel": "SOz1_a_sizeLabel",
			"nm": "SOz1_a_nm",
			"dot": "SOz1_a_dot",
			"cmd": "SOz1_a_cmd",
			"title": "SOz1_a_title",
			"catsRow": "SOz1_a_catsRow",
			"filterOption": "SOz1_a_filterOption",
			"sizeBtn": "SOz1_a_sizeBtn",
			"searchInline": "SOz1_a_searchInline",
			"actWarn": "SOz1_a_actWarn",
			"act": "SOz1_a_act",
			"progress": "SOz1_a_progress",
			"dangerBtn": "SOz1_a_dangerBtn",
			"barWave": "SOz1_a_barWave",
			"top": "SOz1_a_top",
			"src": "SOz1_a_src",
			"loading": "SOz1_a_loading",
			"sizeOn": "SOz1_a_sizeOn",
			"star": "SOz1_a_star",
			"warnBtn": "SOz1_a_warnBtn",
			"sub": "SOz1_a_sub",
			"irow": "SOz1_a_irow",
			"row1": "SOz1_a_row1",
			"cmdDetails": "SOz1_a_cmdDetails",
			"filterBtn": "SOz1_a_filterBtn",
			"grow": "SOz1_a_grow",
			"filterTitle": "SOz1_a_filterTitle",
			"pageInfo": "SOz1_a_pageInfo",
			"filterGroup": "SOz1_a_filterGroup",
			"tag": "SOz1_a_tag",
			"head": "SOz1_a_head",
			"modalNote": "SOz1_a_modalNote",
			"warnLine": "SOz1_a_warnLine",
			"filterBtnOn": "SOz1_a_filterBtnOn",
			"catsCollapsed": "SOz1_a_catsCollapsed",
			"actBroken": "SOz1_a_actBroken",
			"catsWrap": "SOz1_a_catsWrap",
			"desc": "SOz1_a_desc",
			"cancelBtn": "SOz1_a_cancelBtn",
			"okState": "SOz1_a_okState",
			"pagerSize": "SOz1_a_pagerSize",
			"on": "SOz1_a_on",
			"dshmSlide": "SOz1_a_dshmSlide",
			"pagerPages": "SOz1_a_pagerPages",
			"titleRow": "SOz1_a_titleRow",
			"pager": "SOz1_a_pager",
			"themesGrid": "SOz1_a_themesGrid",
			"pageEllipsis": "SOz1_a_pageEllipsis",
			"barFill": "SOz1_a_barFill",
			"err": "SOz1_a_err",
			"grid": "SOz1_a_grid",
			"pageOn": "SOz1_a_pageOn",
			"filterWrap": "SOz1_a_filterWrap",
			"av": "SOz1_a_av",
			"descTight": "SOz1_a_descTight",
			"spec": "SOz1_a_spec",
			"pageBtn": "SOz1_a_pageBtn",
			"card": "SOz1_a_card",
			"tab": "SOz1_a_tab"
		};
		//#endregion
		//#region src/client/MarketSection.tsx
		/**
		* The Market settings section: Discover / Themes / Installed tabs over the
		* /dsh-market/* host routes, with install/update/uninstall flows and the
		* pending-restart bookkeeping in sessionStorage.
		*/
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
			const [skins, setSkins] = (0, react.useState)([]);
			const [tab, setTab] = (0, react.useState)(() => {
				const saved = sessionStorage.getItem("dshm-tab");
				if (saved !== null) sessionStorage.removeItem("dshm-tab");
				return saved || "discover";
			});
			const [q, setQ] = (0, react.useState)("");
			const [cat, setCat] = (0, react.useState)("all");
			const [confirming, setConfirming] = (0, react.useState)(null);
			const [busyUrl, setBusyUrl] = (0, react.useState)(null);
			/** Consecutive idle polls with a pending install that never landed (#32). */
			const idleStrikes = (0, react.useRef)(0);
			const [doneUrls, setDoneUrls] = (0, react.useState)([]);
			const [installError, setInstallError] = (0, react.useState)(null);
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
			/** Structured progress from pnpm ndjson (P1-6). */
			const [progressPhase, setProgressPhase] = (0, react.useState)(null);
			const [progressCurrent, setProgressCurrent] = (0, react.useState)(null);
			const [progressDone, setProgressDone] = (0, react.useState)(0);
			const [cancelling, setCancelling] = (0, react.useState)(false);
			/** Non-live activation results from the last operation, shown as a banner. */
			const [activationWarnings, setActivationWarnings] = (0, react.useState)([]);
			const [removeArmed, setRemoveArmed] = (0, react.useState)(null);
			const [removingName, setRemovingName] = (0, react.useState)(null);
			const [removedCount, setRemovedCount] = (0, react.useState)(0);
			const [envReady, setEnvReady] = (0, react.useState)(true);
			const [envFixing, setEnvFixing] = (0, react.useState)(false);
			const [envFailed, setEnvFailed] = (0, react.useState)(false);
			const [bootId, setBootId] = (0, react.useState)(null);
			/** One-click restart (#14 by @ysyyhhh): server capability + in-flight state. */
			const [restartEnabled, setRestartEnabled] = (0, react.useState)(false);
			const [restarting, setRestarting] = (0, react.useState)(false);
			const [showTop, setShowTop] = (0, react.useState)(false);
			const bodyRef = (0, react.useRef)(null);
			const [sortField, setSortField] = (0, react.useState)("stars");
			const [sortDir, setSortDir] = (0, react.useState)("desc");
			/** Direction labels adapt to the field: stars → asc/desc, added → oldest/newest. */
			const sortDirLabel = (dir) => sortField === "added" ? dir === "desc" ? "sortNewest" : "sortOldest" : dir === "desc" ? "sortDesc" : "sortAsc";
			const [timeRange, setTimeRange] = (0, react.useState)("all");
			const [filterOpen, setFilterOpen] = (0, react.useState)(false);
			const filterWrapRef = (0, react.useRef)(null);
			const [catsOpen, setCatsOpen] = (0, react.useState)(false);
			const [visibleCats, setVisibleCats] = (0, react.useState)(null);
			const catsWrapRef = (0, react.useRef)(null);
			const refreshInstalled = (0, react.useCallback)((force) => {
				fetch("/dsh-market/installed", { cache: "no-store" }).then((res) => res.json()).then((body) => {
					setInstalled(body.installed || {});
					setSkins(body.live || []);
					if (body.activation && typeof body.activation === "object") setActivations(body.activation);
				}).catch(() => {});
				fetch("/dsh-market/updates" + (force === true ? "?force=1" : ""), { cache: "no-store" }).then((res) => res.json()).then((body) => setUpdates(body.updates || {})).catch(() => {});
			}, []);
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
					if (typeof status.boot === "string") setBootId(status.boot);
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
			}, [bootId]);
			(0, react.useEffect)(() => {
				if (bootId === null) return;
				if (doneUrls.length === 0 && updatedNames.length === 0 && removedCount === 0) return;
				sessionStorage.setItem("dshm-restart", JSON.stringify({
					boot: bootId,
					doneUrls,
					updated: updatedNames,
					removed: removedCount
				}));
			}, [
				bootId,
				doneUrls,
				updatedNames,
				removedCount
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
							if (readSession("dshm-pending") !== null && busyUrl !== null) {
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
			(0, react.useEffect)(() => {
				if (!filterOpen) return;
				const onDown = (event) => {
					if (filterWrapRef.current !== null && !filterWrapRef.current.contains(event.target)) setFilterOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				return () => document.removeEventListener("mousedown", onDown);
			}, [filterOpen]);
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
				}).catch((error) => {
					sessionStorage.removeItem("dshm-pending");
					setInstallError(t("installFail") + ": " + String(error));
				}).finally(() => setBusyUrl(null));
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
				fetch("/dsh-market/restart", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				}).then((res) => res.json().then((body) => ({
					status: res.status,
					body
				}))).then(({ status, body }) => {
					if (status !== 202 || body.ok !== true) {
						setRestarting(false);
						setInstallError(t("restartFail") + ": " + String(body.error || "HTTP " + String(status)));
						return;
					}
					awaitNewBoot();
				}).catch(awaitNewBoot);
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
				setRemoveArmed(null);
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
			const pendingRestart = doneUrls.length + updatedNames.length + removedCount;
			const hasUpdates = Object.keys(installed).some((name) => !updatedNames.includes(name) && updates[name] && updates[name].updateAvailable);
			/** Live status line: structured phase, or the human-line fallback. */
			const phasePart = progressPhase != null ? phaseLabel(progressPhase, t) + (progressCurrent !== null ? " · " + progressCurrent : "") + (progressDone > 0 ? " · " + t("packagesDone").replace("{0}", String(progressDone)) : "") : progressLine || t("progressHint");
			const progressText = cancelling ? t("cancelling") + " · " + phasePart : phasePart;
			const themePlugins$1 = data === null ? [] : themePlugins(data.plugins);
			const pluginCard = (p) => {
				const desc = p.description && (p.description[lang] || p.description.en) || "";
				const done = doneUrls.includes(p.url) || hotUrls.includes(p.url);
				const already = isInstalled(p, installed);
				const busy = busyUrl === p.url;
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: Market_module_css_default.nm,
										children: p.name
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
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: p.url,
									target: "_blank",
									rel: "noreferrer",
									style: {
										alignSelf: "flex-start",
										flexShrink: 0
									},
									children: t("viewSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.desc,
							children: desc
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
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.spin }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: Market_module_css_default.grow,
									children: progressText
								}),
								progressPct !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: Market_module_css_default.pct,
									children: [progressPct, "%"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: Market_module_css_default.cancelBtn,
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
				const mounted = skins.includes(instName) || bootEntries.some((e) => e.id === instName);
				const desc = p.description && (p.description[lang] || p.description.en) || "";
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
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: Market_module_css_default.nm,
										children: p.name
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
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: p.url,
									target: "_blank",
									rel: "noreferrer",
									style: {
										alignSelf: "flex-start",
										flexShrink: 0
									},
									children: t("viewSource")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.desc,
							children: desc
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.foot,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
								removingName === instName ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									className: Market_module_css_default.dangerBtn,
									disabled: true,
									children: t("uninstalling")
								}) : removeArmed === instName ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "primary",
									size: "sm",
									className: Market_module_css_default.dangerArmed,
									onClick: () => doUninstall(instName).then(() => {
										if (mounted) {
											sessionStorage.setItem("dshm-tab", "themes");
											location.reload();
										}
									}),
									children: t("confirmRemove")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
									variant: "outline",
									size: "sm",
									className: Market_module_css_default.dangerBtn,
									onClick: () => setRemoveArmed(instName),
									children: t("uninstall")
								}),
								mounted ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.okState,
									children: t("themeActive")
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
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
											className: Market_module_css_default.warnBtn,
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
										className: Market_module_css_default.warnBtn,
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
								children: [t("subtitle") + (data ? " · " + data.count : "") + " · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: "/dsh-market/logs",
									download: "dsh-market-log.txt",
									children: t("exportLog")
								})]
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
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.grow }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
										className: Market_module_css_default.searchInline,
										icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, { size: 14 }),
										placeholder: t("searchPh"),
										value: q,
										onChange: (e) => setQ(e.target.value)
									})
								]
							}),
							!envReady && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.restart,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "🧩" }),
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
							hotUrls.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.restart,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "✨" }),
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
							pendingRestart > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.restart,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "🔄" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: Market_module_css_default.grow,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: pendingRestart }),
											" ",
											t("restartBanner")
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										title: t("restartHint"),
										children: "ℹ️"
									}),
									restartEnabled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										disabled: restarting || busyUrl !== null || updatingName !== null || removingName !== null,
										onClick: doRestart,
										children: restarting ? t("restarting") : t("restartNow")
									})
								]
							}),
							activationWarnings.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.restart,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "⚠️" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
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
							})
						]
					}),
					buildsSkipped !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.restart,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: Market_module_css_default.grow,
							children: [
								t("buildsSkipped"),
								" ",
								buildsSkipped.names.join(", ")
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
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
						})]
					}),
					installError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: Market_module_css_default.err,
						children: [installError, staleName !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.staleAction,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								onClick: () => doUpdate(staleName, true),
								children: t("updateNow")
							})
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: Market_module_css_default.body,
						ref: bodyRef,
						onScroll: (e) => setShowTop(e.currentTarget.scrollTop > 400),
						children: tab === "discover" ? loadError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.empty,
							children: t("loadFail")
						}) : data === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.loading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.spin }), t("loading")]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: Market_module_css_default.filterWrap,
									ref: filterWrapRef,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: filterOpen ? `${Market_module_css_default.filterBtn} ${Market_module_css_default.filterBtnOn}` : Market_module_css_default.filterBtn,
										onClick: () => setFilterOpen((o) => !o),
										children: [t("filter"), filterOpen ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronUpOutline14, { size: 14 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutline14, { size: 14 })]
									}), filterOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: Market_module_css_default.filterPanel,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.filterGroup,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.filterTitle,
													children: t("filterSort")
												}), SORT_FIELD_OPTIONS.map((opt) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: Market_module_css_default.filterOption,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "radio",
														name: "dshm-sort-field",
														checked: sortField === opt.key,
														onChange: () => setSortField(opt.key)
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(opt.label) })]
												}, opt.key))]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.filterGroup,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.filterTitle,
													children: t("filterDir")
												}), SORT_DIR_OPTIONS.map((dir) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: Market_module_css_default.filterOption,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "radio",
														name: "dshm-sort-dir",
														checked: sortDir === dir,
														onChange: () => setSortDir(dir)
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(sortDirLabel(dir)) })]
												}, dir))]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.filterGroup,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													className: Market_module_css_default.filterTitle,
													children: t("filterTime")
												}), TIME_OPTIONS.map((opt) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: Market_module_css_default.filterOption,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "radio",
														name: "dshm-time",
														checked: timeRange === opt.key,
														onChange: () => setTimeRange(opt.key)
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t(opt.label) })]
												}, opt.key))]
											})
										]
									})]
								})]
							})
						}), plugins.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Market_module_css_default.pageBtn,
										disabled: currentPage === 1,
										onClick: () => goToPage(1),
										"aria-label": t("firstPage"),
										children: "«"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Market_module_css_default.pageBtn,
										disabled: currentPage === 1,
										onClick: () => goToPage(currentPage - 1),
										children: t("prevPage")
									}),
									pageItems(currentPage, totalPages).map((item, i) => item === "…" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: Market_module_css_default.pageEllipsis,
										children: "…"
									}, "e" + i) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: item === currentPage ? `${Market_module_css_default.pageBtn} ${Market_module_css_default.pageOn}` : Market_module_css_default.pageBtn,
										onClick: () => goToPage(item),
										children: item
									}, item)),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Market_module_css_default.pageBtn,
										disabled: currentPage === totalPages,
										onClick: () => goToPage(currentPage + 1),
										children: t("nextPage")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: Market_module_css_default.pageBtn,
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
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.pagerSize,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: Market_module_css_default.sizeLabel,
									children: t("perPage")
								}), PAGE_SIZES.map((size) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: size === pageSize ? `${Market_module_css_default.sizeBtn} ${Market_module_css_default.sizeOn}` : Market_module_css_default.sizeBtn,
									onClick: () => changePageSize(size),
									children: size
								}, size))]
							})]
						})] })] }) : tab === "themes" && themeSnap !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(() => {
							const extra = themeSnap.themes.filter((def) => def.id !== "light" && def.id !== "dark");
							return extra.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: `${Market_module_css_default.grid} ${Market_module_css_default.themesGrid}`,
								children: extra.map((def) => themeCard(def.id, def.id, themeSwatch(def)))
							});
						})(), data === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: Market_module_css_default.loading,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.spin }), t("loading")]
						}) : themePlugins$1.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.empty,
							children: t("themeEmpty")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.grid,
							children: themePlugins$1.map(themePluginCard)
						})] }) : Object.keys(installed).length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: Market_module_css_default.empty,
							children: t("installedEmpty")
						}) : Object.entries(installed).map(([name, spec]) => {
							const entry = data === null ? void 0 : entryForDep(data.plugins, name, String(spec));
							const status = updates[name];
							const act = activations[name];
							const meta = act !== void 0 ? activationMeta(act.state, t) : null;
							const version = status && status.version ? "v" + status.version : "";
							const specText = String(spec);
							const ghSpec = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#|$)/.exec(specText);
							const repoUrl = entry !== void 0 ? entry.url : ghSpec !== null ? "https://github.com/" + ghSpec[1] : null;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: Market_module_css_default.irow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { minWidth: 0 },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.nm,
												children: [name, version && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: Market_module_css_default.owner,
													children: " " + version
												})]
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
											act !== void 0 && meta !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.act,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: meta.dot === "done" ? Market_module_css_default.actLive : meta.dot === "error" ? Market_module_css_default.actBroken : Market_module_css_default.actWarn,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
														state: meta.dot,
														size: 7
													}), meta.label]
												}), act.state !== "live" && act.reasons.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
													className: Market_module_css_default.actWhy,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("actWhy") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														className: Market_module_css_default.spec,
														children: act.reasons.join(" / ")
													})]
												})]
											}),
											updatingName === name && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: Market_module_css_default.progress,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: Market_module_css_default.spin }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
														className: Market_module_css_default.grow,
														children: progressText
													}),
													progressPct !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: Market_module_css_default.pct,
														children: [progressPct, "%"]
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: Market_module_css_default.cancelBtn,
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
									repoUrl !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										className: Market_module_css_default.src,
										href: repoUrl + "#readme",
										target: "_blank",
										rel: "noreferrer",
										children: t("readme")
									}),
									updatedNames.includes(name) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
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
									name !== "dsh-market" && name !== "dshmarket" && (removingName === name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										className: Market_module_css_default.dangerBtn,
										disabled: true,
										children: t("uninstalling")
									}) : removeArmed === name ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										size: "sm",
										className: Market_module_css_default.dangerArmed,
										onClick: () => doUninstall(name),
										onMouseLeave: () => setRemoveArmed(null),
										children: t("confirmRemove")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										size: "sm",
										className: Market_module_css_default.dangerBtn,
										disabled: removingName !== null || busyUrl !== null || updatingName !== null,
										onClick: () => setRemoveArmed(name),
										children: t("uninstall")
									}))
								]
							}, name);
						})
					}),
					showTop && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: Market_module_css_default.top,
						title: t("backTop"),
						onClick: () => {
							const el = bodyRef.current;
							if (el) el.scrollTo({
								top: 0,
								behavior: "smooth"
							});
						},
						children: "↑"
					}),
					confirming !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setConfirming(null),
						title: t("confirmTitle") + " " + confirming.name + "?",
						description: confirming.description && (confirming.description[lang] || confirming.description.en) || "",
						footer: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							onClick: () => setConfirming(null),
							children: t("cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							onClick: () => doInstall(confirming),
							children: t("confirm")
						})] }),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								className: Market_module_css_default.cmdDetails,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
									className: Market_module_css_default.cmdSummary,
									children: t("cmdDetails")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: Market_module_css_default.cmd,
									children: confirming.install
								})]
							}),
							looksTerminal(confirming, lang) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: Market_module_css_default.warnLine,
								children: ["🖥️ " + t("terminalWarn") + " ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
									className: Market_module_css_default.src,
									href: confirming.url + "#readme",
									target: "_blank",
									rel: "noreferrer",
									children: t("readme")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: Market_module_css_default.modalNote,
								children: "⚠️ " + t("confirmWarn")
							})
						]
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
		const name = "dsh-market";
		const inject = [
			"slots",
			"locale",
			"theme"
		];
		function apply(ctx) {
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
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map