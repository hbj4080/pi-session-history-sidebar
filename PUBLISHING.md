# 发布到 pi.dev/packages

pi.dev/packages **不是一个上传入口**，它是 npm 的索引：

> 发布到 npm 的包，只要 npm 元数据里带 `pi-package` 关键词，就会被自动收录进 [pi.dev/packages](https://pi.dev/packages)。没有表单、没有 PR、没有审核。

本包的 `package.json` 已经满足收录条件：

```json
"keywords": ["pi-package", "pi-extension", ...],
"pi": { "extensions": ["./extensions/session-history-sidebar.ts"] }
```

---

## 0. 前置检查

| 项 | 状态 |
| --- | --- |
| npm 包名 `pi-session-history-sidebar` | ✅ 已被占用？**否**（`npm view` 返回 404，可用） |
| `pi-package` 关键词 | ✅ 已有 |
| `pi` manifest | ✅ 已声明 `extensions` + `changelogPath` |
| npm 登录 | ❌ 未登录（`npm whoami` → `ENEEDAUTH`） |
| GitHub 仓库 | ✅ `https://github.com/hbj4080/pi-session-history-sidebar`（`main`，已推送） |
| `repository` / `homepage` / `bugs` | ✅ 已指向该仓库 |

## 1. 登录 npm

```bash
npm adduser          # 或 npm login
npm whoami           # 应打印你的用户名
```

没有账号就先在 <https://www.npmjs.com/signup> 注册（邮箱验证 + 开 2FA 更安全）。

## 2. 元数据（已完成）

`package.json` 已包含：

```json
"author": "Hamburman (hbj4080)",
"repository": { "type": "git", "url": "git+https://github.com/hbj4080/pi-session-history-sidebar.git" },
"homepage": "https://github.com/hbj4080/pi-session-history-sidebar#readme",
"bugs": { "url": "https://github.com/hbj4080/pi-session-history-sidebar/issues" }
```

可选补强（在 GitHub 网页上操作，或装上 `gh` CLI）：

- 仓库 **About** 里填一句 description、加上 topics：`pi-package`、`pi-extension`、`pi`、`tui`
- gallery 卡片预览图：`pi.image` 指向公网可访问的 PNG，例如

```json
"pi": { "extensions": ["..."], "image": "https://raw.githubusercontent.com/hbj4080/pi-session-history-sidebar/main/docs/preview.png" }
```

## 3. 检查打包内容

```bash
npm pack --dry-run
```

应只有 5 个文件：`extensions/session-history-sidebar.ts`、`README.md`、`CHANGELOG.md`、`LICENSE`、`package.json`。
（`node_modules/`、`.tgz`、测试脚本不进包 —— `files` 字段已限制）

## 4. 发布

```bash
npm publish --access public
```

- 不带 scope 的名字（如 `pi-session-history-sidebar`）本身即 public，`--access public` 可省，但带上不会出错。
- 如果以后改成 scoped 名字（`@hamburman/pi-session-history-sidebar`），**必须**加 `--access public`，否则默认是私有包、不会出现在 gallery。

## 5. 等收录

- npm 发布成功后，pi.dev 会在**几分钟内**自动抓取（有时需要更久）。
- 手动确认是否已被 npm 索引：<https://www.npmjs.com/search?q=keywords%3Api-package>
- gallery 页面：`https://pi.dev/packages/pi-session-history-sidebar`
- 也可以直接装来验证：

```bash
pi remove D:\SJTU\S3\Discrete_Math\pi-session-history-sidebar   # 先卸本地路径版本
pi install npm:pi-session-history-sidebar@0.1.0
```

> ⚠️ 本地路径安装和 npm 安装是**两种不同的包身份**（pi 用绝对路径 vs 包名去重），同时存在会重复注册 `/history`。切换时先 `pi remove` 旧的。

## 6. 后续发版

```bash
npm version patch        # 或 minor / major；同时更新 CHANGELOG.md
npm publish --access public
pi update --extensions   # 本机更新
```

`CHANGELOG.md` 里 `## [x.y.z]` 段落在用户升级后会在 pi 的 "Extension Updates" 里展示（`pi.changelogPath` 已指向它）。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `npm publish` 报 `403 Forbidden` | 包名被占 / 未验证邮箱 / scoped 包忘了 `--access public` |
| 发布成功但 gallery 没有 | 关键词不是 `pi-package`；或还在抓取窗口内（等几分钟，`npm view <name> keywords` 复查） |
| `pi install` 报 peerDependencies 警告 | 宿主包必须在 `peerDependencies` 用 `"*"`，不能进 `dependencies`（本包已合规） |
| 安装后命令重复注册 | 本地路径版 + npm 版同时存在，`pi remove` 掉其中一个 |
| 用户升级后看不到 changelog | 版本号没涨，或 `CHANGELOG.md` 缺少 `## [x.y.z]` 标题 |
