# Changelog

## [0.1.1] - 2026-11-17

Fixed — jumping to a message now works on transcripts that carry no `messageId`.

- pi only tags message components with `messageId` when it re-renders the chat (e.g. after
  a compaction); messages appended live have no id, so every jump used to report
  "这条消息已不在当前上下文中".
- Jump resolution now cascades: `messageId` → component order (branch order matches the
  panel list) → rendered-text match. No `messageId` is required anymore.
- `/history-debug` reports both counts (`按 id 定位` / `按顺序候选`) and writes a tree dump
  to `~/.pi/agent/session-history-sidebar.log`. Set `PI_HISTORY_LOG` to relocate the log.

## [0.1.0] - 2026-11-17

首个版本。

- 右侧 20% 会话历史侧栏，只覆盖正文视口，不遮挡输入区
- 点击 / Enter 跳转到任意历史消息（基于 `ScrollView` + 组件 `messageId` 行偏移映射）
- 关键词搜索（空格分词 AND、命中高亮、实时过滤）
- 滚轮 / 方向键 / PgUp / PgDn 浏览，溢出时显示滚动条
- 面板打开时不抢键盘；搜索结束后每条退出路径都显式归还焦点，修复“跳转后输入框失灵、只能重启”
- `/history-debug` 诊断命令：可定位条数、行高对齐、滚动视图可用性
