# pi-session-history-sidebar

给 [pi](https://pi.dev) 加一个**右侧会话历史侧栏**：列出当前 session 里之前的每一条对话，点一下就跳转回那段内容。

```
┌─────────────────────────────┬───────────────┐
│                             │ 会话历史 · 42 条│
│  主对话区（正文）            │ 搜索          │
│                             │▍15:10 用户 …  │
│                             │ 15:10 AI   …  │
│                             │ 15:02 用户 …  │
│                             │               │
├─────────────────────────────┴───────────────┤
│ > 在这里正常输入，完全不受影响               │
└─────────────────────────────────────────────┘
```

## 功能

- **右侧 20% 窄栏**，只覆盖正文视口，输入框、状态栏、footer 永远不被遮挡
- **点击跳转**：点列表里的任意一条，主对话立即滚动到那条消息
- **实时列表**：会话继续时自动出现新条目，当前选中项不会乱跳
- **搜索**：点搜索行后输入关键词，实时过滤 + 命中高亮
- **滚轮浏览**：面板装不下时右侧有滚动条，滚轮/`↑↓`/`PgUp`/`PgDn` 都能翻
- **不抢键盘**：面板打开时打字照常进入对话输入框；搜索完（Enter / 点击 / Esc）键盘立刻还回去

## 安装

```bash
# 本地目录（原地加载，改了代码 /reload 即可生效）
pi install ./pi-session-history-sidebar

# 打包后的 tarball
pi install ./pi-session-history-sidebar-0.1.0.tgz

# 发布到 npm 之后
pi install npm:pi-session-history-sidebar

# 只想试一次，不写进 settings
pi -e ./pi-session-history-sidebar
```

装好后 `/reload` 或重启 pi 生效。

> 如果你之前把 `session-history-sidebar.ts` 直接放在 `~/.pi/agent/extensions/`，请先删掉那一份，否则命令会注册两次。

## 使用

| 操作 | 说明 |
| --- | --- |
| `/history` | 打开 / 关闭侧栏 |
| `/history <关键词>` | 打开并带上初始筛选词 |
| `Ctrl+Shift+H` | 打开 / 关闭侧栏 |
| 点列表项 | 跳转到那条消息（键盘立刻回到输入框） |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | 移动选中项 |
| 点搜索行 → 输入 | 关键词过滤（空格分词，多词 AND） |
| `Enter` | 跳转到选中项，并把键盘还给输入框 |
| `Esc` | 清空搜索词并回到对话 |
| 滚轮 | 在列表里浏览 |
| `/history-debug` | 诊断：有多少条能定位、行高是否对齐 |

跳转后面板**保持打开**，方便你连续跳几条；键盘焦点已经还给输入框，所以直接打字回车就是正常发消息。

## 工作原理

pi 的全屏对话区是一个 `ScrollView`，每条消息组件在构造时带上 `messageId`（= session entry id）。侧栏：

1. 读 `ctx.sessionManager.buildContextEntries()` 拿到当前分支的消息列表；
2. 递归遍历 `ScrollView` 里的文档树（`header → resources → chat → 消息组件`），按 `messageId` 记录每条消息在文档中的累计行高；
3. 点某条时 `scrollView.scrollTo(offset - 1, { disableFollow: true })`，就把视口挪到那条消息。

## 已知限制

- 只支持 **fullscreen 模式**（pi 默认）。regular 模式下终端自己管滚动区，pi 没有可移动的视口，面板会给出提示而不是假装跳转。
- 只列出**当前上下文里**的消息：被 compaction 压掉、或不在当前分支上的历史不会出现。
- 依赖 pi 的 TUI 内部结构（`ScrollView`、`messageId`），pi 大版本升级后可能需要跟着改；`/history-debug` 可以快速确认是否还对齐。

## 焦点安全

侧栏在两种情况下会短暂接管键盘（点搜索行、按 `↑↓` 跳转），**每种退出路径都会显式把焦点还给打开面板时的组件**（`unfocus({ target })`），因此不会出现“跳转后输入框失灵、只能重启”的情况。万一真遇到，`Ctrl+Shift+H` 关掉面板即可恢复输入。

## License

MIT
