# 企业与私有插件源

[English](ENTERPRISE.md)

dsh-market 可以在公共目录之外加上你们自己的插件：私有目录、私有 npm、内网 Git、离线包；管理员还可以用一份策略文件统一设定员工能装什么、市场能连哪里。

**什么都不配置时，市场的行为和以前完全一样。** 下面的每一项都是可选的。

- [附加插件目录](#附加插件目录)
- [私有 npm](#私有-npm)
- [内网 Git](#内网-git)
- [离线包](#离线包)
- [策略文件 policy.json](#策略文件-policyjson)
- [安全边界](#安全边界)

## 附加插件目录

目录就是一份和公共目录格式相同的 `plugins.json`。你可以把它放在内网的任何 HTTP 地址上，或者放在本机的一个文件里。

**员工自己添加**：市场设置 → 高级 → 插件目录 → 添加目录，填 URL 或文件的绝对路径。市场会先读一次，显示有多少个插件或读不到的原因，确认后保存。

**管理员统一下发**：写进[策略文件](#策略文件-policyjson)的 `catalogs`，员工看得到但改不了。

加上之后：

- 目录里的插件和公共插件一起出现在「发现」页，卡片上标出来源（比如「Acme 内部」）；有两个以上来源时会多一排来源筛选。
- 同一个插件在两个目录里都有时，以私有目录为准，只显示一张卡片。私有插件排在前面。
- 某个目录读不到（断网、401、格式错误）只影响它自己，页面顶部会说明是哪个目录、为什么、怎么重试；其余目录照常可用。
- AI 搜索、AI 猜你喜欢、`/find-plugin` 都会把私有插件一起算进去。

### 生成目录文件

用仓库里的脚本，从一份简单清单生成 `plugins.json`（脚本不随 npm 包发布，需要先 clone 本仓库）：

```bash
git clone https://github.com/dsh-market/dsh-market && cd dsh-market
node scripts/make-catalog.mjs entries.json -o plugins.json --label "Acme 内部"
```

`entries.json`：

```json
[
  { "npm": "@acme/dsh-notify", "category": "tools" },
  { "npm": "dsh-loop", "category": ["tools", "automation"], "description": "循环执行任务" },
  { "repo": "https://github.com/acme/dsh-theme", "category": "themes",
    "description": { "zh": "公司主题", "en": "Company theme" } }
]
```

名称、描述、仓库地址等缺的字段，脚本会从包自己的 `package.json` 读取。私有 scope 的包用 `~/.npmrc` 里的 `@scope:registry=` 和对应 token 去查。加 `--offline` 则完全不联网，每条都要自己写全。

目录条目可以多写这些字段：

| 字段 | 作用 |
|---|---|
| `npm` | 用这个包名安装（私有 npm 包就填它） |
| `git` | 从内网 Git 安装，见[内网 Git](#内网-git) |
| `screenshots` | 截图地址列表，任何 https 地址都可以（策略关闭外部图片时不显示） |

## 私有 npm

pnpm 本身就读 profile 下的 `.npmrc`，所以安装私有包只要把仓库地址和 token 写进去，Verdaccio、Nexus、Artifactory、GitHub Packages 都一样：

```ini
# <profile>/.npmrc
@acme:registry=https://npm.acme.internal/
//npm.acme.internal/:_authToken=${ACME_NPM_TOKEN}
```

市场自己发出的 npm 请求（查更新、查版本、读更新日志、兼容性检查）也按同样的规则走：

- 按包的 scope 找 `@scope:registry=`，先找 profile 下的 `.npmrc`，再找 `~/.npmrc`。
- profile 的 `.npmrc` 里的 `registry=`（不带 scope）也生效，作为默认仓库；`~/.npmrc` 里的这一行不读，避免改变普通用户的行为。
- 认证支持 `_authToken`、`_auth`、`username` + `_password`，`${ENV}` 会展开。
- token 只发给它对应的那个仓库，不会出现在日志、导出日志或浏览器里。

GitHub Packages 示例：

```ini
@acme:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## 内网 Git

目录条目里写 `git`，支持 https 和 ssh，可以用 `#` 指定标签或提交：

```json
{
  "name": "acme-review",
  "url": "https://gitlab.acme.internal/tools/acme-review",
  "category": "tools",
  "description": { "zh": "内部代码评审助手", "en": "Internal review helper" },
  "git": "git+ssh://git@gitlab.acme.internal/tools/acme-review.git#v1.2.0"
}
```

- 认证用这台机器自己的 git 凭据（ssh key、credential helper），市场不经手。
- 地址里不能带密码。
- 只有目录里写了的 `git` 地址才会被安装，网页请求里带的地址一律不认。

## 离线包

给完全不能访问 npm 的机器用：把目录和插件文件打成一个包，拷过去导入。

**打包**（在能联网的机器上）：

```bash
node scripts/offline-pack.mjs --catalog plugins.json --out acme-offline.tgz
```

- `npm` 条目会下载对应版本（条目里写了 `version` 就用它，否则用 `latest`）并校验完整性。
- `git` 条目会浅克隆并原样打包。注意它是**源码**，只有仓库里提交了运行所需的构建产物，离线才能装。
- **带依赖的插件**只打包插件本身，脚本会列出这些依赖；安装时仍要从仓库拉依赖。真正完全断网的环境，请搭一个内网 npm 镜像（Verdaccio、Nexus 等），再配合[私有 npm](#私有-npm)使用。

**导入**：市场设置 → 高级 → 插件目录 → 导入离线包。

- 导入后会变成一个本地目录，里面的插件从包内的文件安装，不访问网络。
- 导入时会严格检查，任何可疑内容都会拒绝整个包、什么都不写入：
  - `..`、绝对路径、链接、设备文件；
  - `plugins.json` 和 `tarballs/*.tgz` 以外的文件；
  - 超过 512 MB 或超过 2000 个文件。
- 从离线包装的插件不检查更新，要更新就导入新版的离线包：它会替换同一个目录（按目录名称认）的旧导入。然后把已装的插件卸载再装一遍，就会用上新版。

管理员也可以把离线包解压到固定位置，在策略文件里用 `catalogs[].file` 指向它。

## 策略文件 policy.json

一份由管理员维护的 JSON，市场只读不写。查找顺序，找到第一个就用它：

1. 环境变量 `DSH_MARKET_POLICY`（绝对路径）
2. macOS / Linux：`/etc/dsh-market/policy.json`；Windows：`%ProgramData%\dsh-market\policy.json`
3. `<DSH_HOME>/dsh-market/policy.json`

> **「员工改不了」靠的是文件权限。** 位置 1 和 2 要设成只有管理员能写，比如 `root` 所有、权限 `644`。位置 3 在用户自己的目录里，只适合个人使用，约束不了用户本人。

完整示例（所有字段都可选）：

```json
{
  "catalogs": [
    {
      "id": "acme",
      "label": { "zh": "Acme 内部", "en": "Acme internal" },
      "url": "https://plugins.acme.internal/plugins.json",
      "headers": { "Authorization": "Bearer ${ACME_PLUGINS_TOKEN}" }
    },
    { "id": "acme-offline", "label": "Acme 离线", "file": "/opt/acme/dsh-offline" }
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

| 字段 | 默认 | 作用 |
|---|---|---|
| `catalogs` | 无 | 附加目录。`id` 用小写字母、数字和 `-`；`url` 或 `file` 二选一；`headers` 里的 `${ENV}` 在请求时从环境变量展开，不会写入日志 |
| `publicCatalog` | `true` | `false` 时不加载公共目录，只用你们的目录 |
| `userCatalogs` | `true` | `false` 时员工不能自己添加目录，已添加的也不再加载 |
| `allow` | 不限 | 允许安装的插件，按 npm 包名或条目名匹配，只支持 `*` 通配；不在名单里的能看不能装 |
| `pins` | 无 | 固定版本：安装时只装这个版本，更新最多提示到这个版本；卡片上会显示「版本由你的组织固定」 |
| `telemetry` | `true` | `false` 时强制关闭匿名使用计数，开关锁定 |
| `comments` | `true` | `false` 时不显示评论，也不访问 giscus 和 GitHub |
| `externalImages` | `true` | `false` 时不加载任何外部图片：截图、头像、图标、README 图片 |
| `mirrors` | 按下载区域 | 目录、npm、GitHub 代理的地址；优先级高于 `DSHM_*` 环境变量和下载区域设置，设置后员工不能改 |

被策略设定的项，在设置里显示为锁定，并标注「由你的组织设置」。

**策略文件写坏时**（不是合法的 JSON）：浏览照常，但**所有安装都会暂停**。设置里会写明是哪个文件、错在第几个字符，并提示联系管理员。之所以这样设计，是因为管理员写了策略就会期待它生效，一份读不了的策略不能悄悄当作「没有策略」。单个字段写错只忽略那一个字段并提示；只有 `allow` 写错时会按「什么都不允许」处理。

## 安全边界

- 安装接口仍然只接受**已加载目录里的条目**，现在的名单是所有目录的并集，再经过 `allow` 过滤。网页不能让本地服务安装任意来源。
- 添加和移除目录的接口只接受市场页面本身发来的请求。
- 目录的 `headers`、`.npmrc` 里的 token 都只在服务端使用，不会出现在日志、导出日志或浏览器里。
- 离线包里的安装路径只在服务端解析，而且只能指向包内的文件。

更多见 [SECURITY.md](SECURITY.md)。
