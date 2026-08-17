<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-market logo">
</p>

# dsh-market

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dshmarket)](https://www.npmjs.com/package/dshmarket)
[![stars](https://img.shields.io/github/stars/dsh-market/dsh-market?style=flat)](https://github.com/dsh-market/dsh-market)

装在 DeepSeek Harness 里的插件市场。打开设置 → **插件市场** → 逛一逛，点一下，装好。

![dsh-market](assets/demo-zh.png)

主题一键换——装完即生效，点一下切换，不用重启：

![主题](assets/themes-zh.png)

## 安装

```sh
dsh plugin --profile web add dshmarket
```

重启 `dsh web`，打开 **设置 → 插件市场**。

## 你会得到

- **逛与搜**——完整社区目录（800+ 插件，每天在涨），分类筛选、star 数、最热/最新排序，中英描述跟随界面语言
- **截图展示**——安装弹窗内 App Store 式截图：作者可在 registry 里策展，没有则自动从 README 抽取；图片仅从 GitHub 图床加载，且只在你打开弹窗后才发请求
- **主题**——独立主题页：装完立即生效，点一下切换（主题互斥、选择跨重启保留），卸载即恢复
- **一键安装**——确认来源，实时进度；多数插件刷新页面即可用，无需重启
- **备份与恢复**——把 profile 的插件清单与配置导出为可读 JSON，换机导入，存到 WebDAV 并每日自动备份，或通过私有 GitHub Gist 跨机器同步；恢复采用**合并**方式（备份之后新装的插件会保留），写入前校验、失败自动回滚
- **更新**——逐插件检测（npm 版本或锁定 commit 对比 HEAD），一键更新或全部更新；市场自己也走同一通道升级
- **卸载**——两步确认防误触；本次会话装的插件即点即卸
- **按需重启**——无法热加载的变更会在待重启提示旁显示一键重启；操作仅接受本机同源请求
- **零术语**——缺组件（pnpm）时市场自己发现、一键自动装好，全程不见命令行
- **导出日志**——一键生成脱敏纯文本日志方便反馈（home 路径与密钥形状已打码；任何数据都不会被上传）

## 速度

只要插件发布了 npm 包（registry 会校验其 repository 指回同一仓库,防冒名）,安装即走 npm tarball 而非整仓 GitHub 下载——通常秒级;仅 GitHub 分发的插件取决于你到 GitHub 的网络。

## 安全

- 只允许安装 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选列表内的来源,其它一律拒绝
- 构建脚本默认禁止执行（pnpm ≥10）,放行与否由你按包显式决定
- 终端/命令行类插件装进网页版前会被明确提醒
- 安装接口只接受同源 POST;市场不会向任何地方上报数据
- 备份可能包含 profile 配置里的密钥——导出与上传前 UI 会明确提醒;WebDAV 同步仅限 https、拒绝内网地址,且密码永不落盘浏览器
- 重启接口还要求客户端直接来自环回地址（拒绝代理转发请求），并使用原入口、参数、环境和工作目录重新启动 DSH
- 一键重启会启动脱离终端的替代进程。若 DSH 由 systemd、launchd、pm2 等进程管理器托管，请设置插件选项 `allowRestart: false`，交由管理器负责重启；待重启提示仍会显示，但按钮会隐藏
- 从终端启动时，替代进程脱离原终端，关闭原终端后仍会继续运行
- 收录 ≠ 背书:插件是第三方代码,请只安装你信任的来源

## 提交你的插件

**这个仓库是市场应用本身，不是插件目录。** 市场里的插件列表来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)——想让你的插件上架，请去**那边**提 PR（在列表里加一条即可，站点和本市场会自动收录，通常一天内生效）。请不要往本仓库提插件条目。

## 路线图与反馈

- 功能规划见 [Roadmap](https://github.com/orgs/dsh-market/projects/1)，每一项都欢迎社区 PR（动手前在对应 issue 里说一声）
- Bug 与建议请提 [issue](https://github.com/dsh-market/dsh-market/issues)，附上市场页面的「导出日志」能让排查快十倍

## 数据源

实时来自 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)——精选条目、npm 映射、star 数由 CI 每日刷新——内置快照做离线兜底。

## 友情链接

### DSH Desktop（dataelement）

[dsh-desktop](https://github.com/dataelement/dsh-desktop)——DeepSeek Harness 桌面客户端：无需自装 Node.js 即可运行和管理本地 Harness，并默认预置本插件市场。[dshdesktop.com](https://dshdesktop.com)

### DeepSeek Harness Desktop（hairyf）

[deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop)——基于 **Tauri**（Rust + Web）构建的 DeepSeek Harness 原生桌面客户端：一键本地安装并启动，无需自装 Node.js；首次启动可选择安装本插件市场作为推荐插件。

### DSH Get

[DSH Get](https://www.dshget.com/)——DeepSeek Harness 插件的网页检索目录：分类筛选、中英描述、安装命令与插件详情页；其规范化的目录快照公开在 [bobby-sheng/dshget-data](https://github.com/bobby-sheng/dshget-data)。

### modlens

[modlens](https://github.com/liustack/modlens)——全网第一个 DeepSeek Harness 视觉插件，为 DeepSeek、GLM 等纯文本模型外挂视觉能力，粘贴图片即得结构化 JSON 证据（OCR、版面、语义）。本市场内即可直接安装：

```sh
dsh plugin --profile web add @liustack/modlens
```

## 许可

MIT · [dshmarket.com](https://dshmarket.com)
