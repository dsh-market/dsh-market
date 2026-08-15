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

### DSH Desktop

如果 DSH Desktop 版本提供公开的 `desktopProfiles` 与 `desktopPnpm`
服务，可从 **Open DSH Terminal** 安装：

```sh
dsh plugin add dshmarket
```

市场会自动使用该代 Desktop 已锁定的活动 profile，以及 Desktop 内置的
pnpm 操作服务；不会探测或安装系统 pnpm，应用重启仍由 Desktop 负责。
没有这些服务的普通 DSH 会继续使用现有 profile/argv/CLI 路径。检测顺序遵循
Desktop 支持的[跨环境插件 contract](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/4f68147091e585aaa1d815f99d30a657b3842d7c/dsh-plugin-desktop/docs/plugin-services.zh.md#跨环境插件可选-desktop-adapter-与普通-dsh-fallback)。
兼容 Desktop 并不代表市场已预装或捆绑进 Desktop。

## 你会得到

- **逛与搜**——完整社区目录（300+ 插件，每天在涨），分类筛选、star 数、最热/最新排序，中英描述跟随界面语言
- **主题**——独立主题页：装完立即生效，点一下切换（主题互斥、选择跨重启保留），卸载即恢复
- **一键安装**——确认来源，实时进度；多数插件刷新页面即可用，无需重启
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

### DeepSeek Harness Desktop

[DeepSeek Harness Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop) 是一款为 DeepSeek Harness 生态打造的现代化桌面端，无需在系统中安装 Node.js 即可启动和管理本地 Harness 服务。兼容版本可通过公开的 profile 与包操作服务运行用户自行安装的 dsh-market；是否预装仍由 Desktop 项目决定。

[访问官网](https://www.dshdesktop.cn) · [GitHub](https://github.com/anywhere-labs/deepseek-harness-desktop)

## 许可

MIT · [dshmarket.com](https://dshmarket.com)
