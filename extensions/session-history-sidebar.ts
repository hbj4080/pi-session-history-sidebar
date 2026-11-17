/**
 * Session history sidebar.
 *
 * Adds a right-hand panel that lists the earlier messages of the CURRENT session
 * (the active branch, compaction applied). Selecting an entry with Enter or a mouse
 * click scrolls the main transcript viewport to that message.
 *
 * Usage:
 *   /history            open the panel
 *   /history <text>     open the panel with a pre-filled filter
 *   ctrl+shift+h        open the panel
 *   /history-debug      report how many entries can be mapped to components
 *
 * Keys: up/down/pgup/pgdn/home/end move, type to filter, backspace deletes,
 *       Enter (or click) jumps to that message and hands the keyboard back to
 *       the chat editor, Esc clears the filter and hands the keyboard back too,
 *       ctrl+shift+h closes the panel.
 *
 * Jumping relies on pi's fullscreen transcript (ScrollView + message components
 * tagged with messageId). In regular (non-fullscreen) rendering pi has no scroll
 * viewport to move, so the panel then explains that instead of jumping.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

interface HistoryItem {
	id: string;
	kind: "user" | "assistant" | "summary";
	role: string;
	time: string;
	text: string;
	preview: string;
}

interface SidebarTheme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	style(text: string, style: { fg?: string; bg?: string; bold?: boolean; dim?: boolean }): string;
}

// Access to pi-tui internals that are not part of the public extension surface.
type AnyTui = any;

// ---------------------------------------------------------------------------
// session data
// ---------------------------------------------------------------------------

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[图片]");
	}
	return parts.join("\n");
}

function formatTime(timestamp: unknown): string {
	const value = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
	if (!Number.isFinite(value)) return "--:--";
	const date = new Date(value);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/** Pad to a visible-column width (CJK aware); role labels are 2-column chars. */
function padRight(text: string, columns: number): string {
	const width = visibleWidth(text);
	return width >= columns ? text : text + " ".repeat(columns - width);
}

function previewOf(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return "(空)";
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function collectItems(ctx: ExtensionCommandContext): HistoryItem[] {
	let entries: any[] = [];
	try {
		entries = ctx.sessionManager.buildContextEntries() as any[];
	} catch {
		entries = ctx.sessionManager.getEntries() as any[];
	}

	const items: HistoryItem[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "message") {
			const role = entry.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = messageText(entry.message).trim();
			if (!text) continue;
			items.push({
				id: String(entry.id),
				kind: role,
				role: role === "user" ? "用户" : "AI",
				time: formatTime(entry.timestamp),
				text,
				preview: previewOf(text),
			});
			continue;
		}
		if (entry.type === "compaction") {
			const text = typeof entry.summary === "string" ? entry.summary.trim() : "";
			items.push({
				id: String(entry.id),
				kind: "summary",
				role: "摘要",
				time: formatTime(entry.timestamp),
				text,
				preview: previewOf(text || "(上下文压缩摘要)"),
			});
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// transcript geometry
// ---------------------------------------------------------------------------

interface OffsetState {
	y: number;
	offsets: Map<string, number>;
}

const offsetCache = new WeakMap<object, { key: string; state: OffsetState }>();

function resolveTranscript(tui: AnyTui): { scroll: any; document: any } {
	const scroll = typeof tui?.getPrimaryScrollView === "function" ? tui.getPrimaryScrollView() : undefined;
	const document = scroll?.child ?? tui?.children?.[0];
	return { scroll, document };
}

/**
 * Screen rectangle of the transcript viewport.
 *
 * The sidebar covers only this region, so the editor, status bar and footer stay
 * visible and usable while the panel is open.
 */
function transcriptRect(tui: AnyTui): { top: number; height: number } | undefined {
	const root = (tui as any)?.currentLayout?.root;
	const scroll = typeof tui?.getPrimaryScrollView === "function" ? tui.getPrimaryScrollView() : undefined;
	const visit = (box: any, depth = 0): any => {
		if (!box || depth > 8) return undefined;
		if (box.scrollView && (!scroll || box.scrollView === scroll)) return box.rect;
		const children: any[] = Array.isArray(box.children) ? box.children : [];
		for (const child of children) {
			const found = visit(child, depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	const rect = visit(root);
	if (!rect) return undefined;
	return { top: Math.max(0, Math.round(rect.y ?? 0)), height: Math.max(1, Math.round(rect.height ?? 0)) };
}

function heightOf(component: any, width: number): number {
	try {
		const lines = component?.render?.(width);
		return Array.isArray(lines) ? lines.length : 0;
	} catch {
		return 0;
	}
}

/** Cheap structural signature: new/removed components change it, streaming does not. */
function treeSize(node: any, depth = 0): number {
	if (!node || depth > 8) return 1;
	const children: any[] = Array.isArray(node.children) ? node.children : [];
	let size = 1;
	for (const child of children) size += treeSize(child, depth + 1);
	return size;
}

/**
 * Walk the transcript tree accumulating rendered line offsets.
 *
 * The viewport document is a tree of containers: pi's document container holds the
 * header/resources containers plus the chat container, and message components sit
 * inside those. We descend any node exposing `children`, but only trust the descent
 * when the children's rendered height equals the node's own rendered height (i.e. the
 * container is transparent). Otherwise the node is measured as one opaque block.
 * Class identity is deliberately not used: extensions may get a different pi-tui
 * module instance than the host, so `instanceof` is not reliable here.
 * Components carrying a string `messageId` are the jump targets.
 */
function walkOffsets(node: any, width: number, state: OffsetState, depth = 0): void {
	if (!node) return;
	const id = node.messageId;
	if (typeof id === "string") {
		if (!state.offsets.has(id)) state.offsets.set(id, state.y);
		state.y += heightOf(node, width);
		return;
	}
	const children: any[] = Array.isArray(node.children) ? node.children : [];
	if (children.length > 0 && depth < 8) {
		const beforeY = state.y;
		const beforeKeys = new Set(state.offsets.keys());
		for (const child of children) walkOffsets(child, width, state, depth + 1);
		const own = heightOf(node, width);
		if (state.y - beforeY === own) return; // transparent container
		for (const key of [...state.offsets.keys()]) if (!beforeKeys.has(key)) state.offsets.delete(key);
		state.y = beforeY + own;
		return;
	}
	state.y += heightOf(node, width);
}

function scanTranscript(document: any, width: number): OffsetState {
	const state: OffsetState = { y: 0, offsets: new Map<string, number>() };
	if (!document) return state;
	const key = `${treeSize(document)}@${width}`;
	const cached = offsetCache.get(document);
	if (cached && cached.key === key) return cached.state;
	walkOffsets(document, width, state);
	offsetCache.set(document, { key, state });
	return state;
}

/** Cumulative rendered line offset of every message component in the transcript. */
function computeOffsets(document: any, width: number): Map<string, number> {
	return scanTranscript(document, width).offsets;
}

interface JumpResult {
	ok: boolean;
	reason?: string;
}

function jumpToItem(tui: AnyTui, item: HistoryItem): JumpResult {
	const { scroll, document } = resolveTranscript(tui);
	if (!scroll || !document) {
		return { ok: false, reason: "当前不是全屏模式，无法滚动定位" };
	}
	const terminalWidth = tui?.terminal?.columns ?? 80;
	const width = typeof scroll.getContentWidth === "function" ? scroll.getContentWidth(terminalWidth) : terminalWidth;
	const offsets = computeOffsets(document, width);
	const offset = offsets.get(item.id);
	if (offset === undefined) {
		return { ok: false, reason: "这条消息已不在当前上下文中（可能被压缩或不在当前分支）" };
	}
	scroll.scrollTo(Math.max(0, offset - 1), { disableFollow: true });
	if (typeof tui.flash === "function") {
		tui.flash(`↪ ${item.role} ${item.time} · ${item.preview}`);
	}
	tui.requestRender?.();
	return { ok: true };
}

// ---------------------------------------------------------------------------
// sidebar component
// ---------------------------------------------------------------------------

/** Style every occurrence of the (already lowercased) tokens inside `text`. */
function highlightMatches(text: string, tokens: string[], theme: SidebarTheme): string {
	if (tokens.length === 0) return text;
	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const token of tokens) {
		if (!token) continue;
		let from = 0;
		while (from < lower.length) {
			const at = lower.indexOf(token, from);
			if (at < 0) break;
			ranges.push([at, at + token.length]);
			from = at + token.length;
		}
	}
	if (ranges.length === 0) return text;
	ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const merged: Array<[number, number]> = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
		else merged.push([range[0], range[1]]);
	}
	let out = "";
	let cursor = 0;
	for (const [start, end] of merged) {
		out += text.slice(cursor, start);
		out += theme.style(text.slice(start, end), { fg: "warning", bold: true });
		cursor = end;
	}
	return out + text.slice(cursor);
}

class HistorySidebar {
	focused = false;
	private cursor = 0;
	private top = 0;
	private viewportRows = 10;
	private query: string;
	private anchorId?: string;
	private cacheItems: HistoryItem[] | null = null;

	/** pi sets `focused` on the component when it owns the keyboard. */
	private get searchMode(): boolean {
		return this.focused;
	}

	constructor(
		private readonly tui: AnyTui,
		private readonly getItems: () => HistoryItem[],
		private readonly theme: SidebarTheme,
		private readonly onPick: (item: HistoryItem) => void,
		private readonly onClose: () => void,
		private readonly focusPanel: (() => void) | undefined,
		private readonly blurPanel: (() => void) | undefined,
		initialQuery = "",
	) {
		this.query = initialQuery;
		this.cursor = initialQuery.trim() ? 0 : Math.max(0, this.filtered.length - 1);
		this.anchorId = this.filtered[this.cursor]?.id;
	}

	invalidate(): void {
		this.cacheItems = null;
	}

	/** Live session data, rebuilt at most a few times per second while streaming. */
	private get items(): HistoryItem[] {
		if (!this.cacheItems) this.cacheItems = this.getItems();
		return this.cacheItems;
	}

	/** Rows the panel occupies: the transcript area only, never the editor/dock. */
	private panelRows(): number {
		const terminalRows = this.tui?.terminal?.rows ?? 30;
		const rect = transcriptRect(this.tui);
		const height = rect ? rect.height : Math.max(6, terminalRows - 6);
		return Math.max(6, Math.min(height, terminalRows));
	}

	private enterSearch(): void {
		if (this.focused) return;
		this.focusPanel?.();
		this.tui.requestRender?.();
	}

	private exitSearch(): void {
		if (!this.focused) return;
		this.blurPanel?.();
		this.tui.requestRender?.();
	}

	private get tokens(): string[] {
		return this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	}

	private get filtered(): HistoryItem[] {
		const tokens = this.tokens;
		if (tokens.length === 0) return this.items;
		return this.items.filter((item) => {
			const haystack = `${item.role} ${item.text}`.toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
	}

	private move(delta: number, absolute?: number): void {
		const list = this.filtered;
		if (list.length === 0) {
			this.cursor = 0;
			this.anchorId = undefined;
			return;
		}
		this.cursor = absolute !== undefined ? absolute : this.cursor + delta;
		this.cursor = Math.min(Math.max(0, this.cursor), list.length - 1);
		this.anchorId = list[this.cursor]?.id;
	}

	private resetForQuery(): void {
		this.cursor = 0;
		this.top = 0;
		this.anchorId = this.filtered[0]?.id;
	}

	private pad(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "…", true);
		const fill = width - visibleWidth(clipped);
		return fill > 0 ? clipped + " ".repeat(fill) : clipped;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const rows = this.panelRows();
		const inner = Math.max(12, width - 2);
		this.cacheItems = null;
		const list = this.filtered;
		// 1 title row + 1 search row + list + 1 footer row = transcript height
		const listRows = Math.max(1, rows - 3);
		this.viewportRows = listRows;

		if (this.anchorId) {
			const found = list.findIndex((item) => item.id === this.anchorId);
			if (found >= 0) this.cursor = found;
		}
		if (this.cursor >= list.length) this.cursor = Math.max(0, list.length - 1);
		if (this.cursor < 0) this.cursor = 0;
		if (this.cursor < this.top) this.top = this.cursor;
		if (this.cursor >= this.top + listRows) this.top = this.cursor - listRows + 1;
		const maxTop = Math.max(0, list.length - listRows);
		if (this.top > maxTop) this.top = maxTop;
		if (this.top < 0) this.top = 0;

		const border = (text: string) => theme.fg("border", text);
		const out: string[] = [];

		// title
		const counter = list.length === this.items.length ? `${this.items.length}` : `${list.length}/${this.items.length}`;
		const titleText = ` 会话历史 · ${counter} 条 `;
		const title = theme.style(truncateToWidth(titleText, inner, "…"), { fg: "accent", bold: true });
		out.push(border("┌") + title + border("─".repeat(Math.max(0, inner - visibleWidth(title)))) + border("┐"));

		// search box (clickable: clicking it hands keyboard focus to the panel)
		const searchLabel = inner >= 26 ? " 搜索 " : " ⌕ ";
		const caret = this.searchMode ? theme.bg("selectedBg", " ") : "";
		const searchBody =
			theme.fg(this.searchMode ? "accent" : "dim", searchLabel) + theme.fg("text", this.query) + caret;
		const searchInfo = this.query.trim()
			? theme.fg("muted", `${list.length}条`)
			: this.searchMode || inner < 26
				? ""
				: theme.fg("dim", "点击搜索");
		const searchGap = Math.max(0, inner - visibleWidth(searchBody) - visibleWidth(searchInfo));
		out.push(border("│") + this.pad(searchBody + " ".repeat(searchGap) + searchInfo, inner) + border("│"));

		// list with a thin scrollbar on the right edge when it overflows
		const needBar = list.length > listRows;
		const textWidth = Math.max(6, inner - (needBar ? 1 : 0));
		const thumbSize = needBar ? Math.max(1, Math.round((listRows * listRows) / list.length)) : 0;
		const thumbStart = needBar
			? Math.min(
					Math.max(0, listRows - thumbSize),
					Math.round((this.top * (listRows - thumbSize)) / Math.max(1, list.length - listRows)),
				)
			: 0;

		for (let row = 0; row < listRows; row++) {
			const index = this.top + row;
			const item = list[index];
			if (!item) {
				const empty = list.length === 0 && row === 0 ? ` ${theme.fg("muted", "没有匹配的消息")}` : "";
				const padded = this.pad(empty, textWidth);
				out.push(border("│") + padded + (needBar ? " " : "") + border("│"));
				continue;
			}
			const selected = index === this.cursor;
			const marker = selected ? "▍" : " ";
			const roleColor = item.kind === "user" ? "accent" : item.kind === "summary" ? "warning" : "success";
			const roleLabel =
				textWidth >= 26
					? padRight(item.role, 4)
					: item.kind === "user"
						? "用"
						: item.kind === "summary"
							? "摘"
							: "AI";
			const timePart = textWidth >= 34 ? `${theme.fg("muted", item.time)} ` : "";
			const body = `${marker} ${timePart}${theme.fg(roleColor, roleLabel)} ${highlightMatches(item.preview, this.tokens, theme)}`;
			let line = this.pad(body, textWidth);
			if (selected) line = theme.bg("selectedBg", line);
			if (needBar) {
				const isThumb = row >= thumbStart && row < thumbStart + thumbSize;
				line += theme.fg(isThumb ? "accent" : "borderMuted", isThumb ? "▐" : "│");
			}
			out.push(border("│") + line + border("│"));
		}

		// footer
		const position = list.length > 0 ? `${this.cursor + 1}/${list.length}` : "0/0";
		const hintText = this.searchMode
			? ` ${position} · ↑↓ 移动 · Enter 跳转 · Esc 回到对话 `
			: ` ${position} · 滚轮 浏览 · 点击 跳转 · Ctrl+Shift+H 关闭 `;
		const hint = theme.fg("dim", truncateToWidth(hintText, inner, "…"));
		out.push(border("└") + hint + border("─".repeat(Math.max(0, inner - visibleWidth(hint)))) + border("┘"));
		return out;
	}

	handleInput(data: string): void {
		const list = this.filtered;
		if (matchesKey(data, "ctrl+shift+h")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "pageup")) this.move(-this.viewportRows);
		else if (matchesKey(data, "pagedown")) this.move(this.viewportRows);
		else if (matchesKey(data, "home")) this.move(0, 0);
		else if (matchesKey(data, "end")) this.move(0, list.length - 1);
		else if (matchesKey(data, "enter")) {
			const item = list[this.cursor];
			if (item) this.onPick(item);
			// Hand the keyboard back so the next Enter submits a chat prompt instead of jumping again.
			this.exitSearch();
			return;
		} else if (matchesKey(data, "escape")) {
			// One Esc always leaves search mode: clear the filter, then release the keyboard.
			if (this.query) {
				this.query = "";
				this.resetForQuery();
				this.exitSearch();
				return;
			}
			if (this.searchMode) {
				this.exitSearch();
				return;
			}
			this.onClose();
			return;
		} else if (matchesKey(data, "ctrl+u")) {
			this.query = "";
			this.resetForQuery();
		} else if (matchesKey(data, "backspace")) {
			this.query = Array.from(this.query).slice(0, -1).join("");
			this.resetForQuery();
		} else if (data.length === 1 && data >= " " && data !== "\x7f") {
			this.query += data;
			this.resetForQuery();
		} else {
			return;
		}
		this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
		this.tui.requestRender?.();
	}

	handleMouse(event: any): any {
		if (!event) return undefined;
		const listTop = 2; // title row + search row
		const listBottom = listTop + this.viewportRows;
		if (event.type === "wheel") {
			const delta = typeof event.wheelDelta === "number" ? event.wheelDelta : 0;
			this.move(delta < 0 ? -3 : 3);
			this.tui.requestRender?.();
			return { handled: true };
		}
		if (event.type === "press" || event.type === "click") {
			if (event.y === 1) {
				// Search row: take keyboard focus so typing filters instead of chatting.
				this.enterSearch();
				return { handled: true, focus: true };
			}
			if (event.y >= listTop && event.y < listBottom) {
				const index = this.top + (event.y - listTop);
				if (index >= 0 && index < this.filtered.length) {
					this.cursor = index;
					this.anchorId = this.filtered[index]?.id;
					const item = this.filtered[index];
					this.tui.requestRender?.();
					this.onPick(item);
					// Never keep the keyboard after a jump: chatting must keep working.
					this.exitSearch();
					return { handled: true };
				}
				return { handled: true };
			}
			if (event.y >= listBottom) {
				this.onClose();
				return { handled: true };
			}
			return { handled: true };
		}
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function sessionHistorySidebar(pi: ExtensionAPI) {
	let open = false;
	let closeActive: (() => void) | undefined;

	async function showSidebar(ctx: ExtensionCommandContext, initialQuery = ""): Promise<void> {
		// Toggle: a second /history (or Ctrl+Shift+H) closes an open sidebar.
		if (open) {
			closeActive?.();
			return;
		}
		const initial = collectItems(ctx);
		if (initial.length === 0) {
			ctx.ui.notify("当前会话还没有可跳转的消息", "info");
			return;
		}
		open = true;
		// Live list: cheap to rebuild, throttled so streaming does not spam the session log.
		let cachedItems = initial;
		let cachedAt = 0;
		let tuiRef: AnyTui | undefined;
		let handleRef: any;
		const getItems = () => {
			const now = Date.now();
			if (now - cachedAt > 500) {
				cachedItems = collectItems(ctx);
				cachedAt = now;
			}
			return cachedItems;
		};
		try {
			await ctx.ui.custom<void>(
				(tui: AnyTui, theme: SidebarTheme, _keybindings: unknown, done: (value?: void) => void) => {
					tuiRef = tui;
					let closed = false;
					const close = () => {
						if (closed) return;
						closed = true;
						done();
					};
					closeActive = close;
					// The component that owned the keyboard when the panel opened (the chat editor).
					// Restoring this explicitly keeps "type → Enter" working no matter how the
					// overlay was focused or how pi resolves its own preFocus fallback.
					const previousFocus = (tui as any).focusedComponent;
					let component: HistorySidebar | undefined;
					const pick = (item: HistoryItem) => {
						if (closed) return;
						const result = jumpToItem(tui, item);
						if (!result.ok) ctx.ui.notify(result.reason ?? "无法定位这条消息", "warning");
					};
					const blur = () => {
						// `unfocus()` alone may fall back to a stale/undefined preFocus, which leaves
						// pi with no focused component and swallows every keystroke. Always hand the
						// keyboard back to a concrete component (the editor we took it from).
						const target = previousFocus && previousFocus !== component ? previousFocus : undefined;
						if (target) handleRef?.unfocus?.({ target });
						else handleRef?.unfocus?.();
					};
					component = new HistorySidebar(
						tui,
						getItems,
						theme,
						pick,
						close,
						() => handleRef?.focus?.(),
						blur,
						initialQuery,
					);
					return component as any;
				},
				{
					overlay: true,
					// half of the previous 40% width
					overlayOptions: () => {
						const rect = tuiRef ? transcriptRect(tuiRef) : undefined;
						if (!tuiRef) return { anchor: "top-right" as const, width: "20%", minWidth: 20, margin: 0 };
						return {
							anchor: "top-right" as const,
							width: "20%",
							minWidth: 20,
							// Cover the transcript only: the editor, status bar and footer stay usable.
							maxHeight: rect ? rect.height : "100%",
							offsetY: rect?.top ?? 0,
							margin: 0,
							// Never steal keystrokes: typing keeps going to the chat editor.
							nonCapturing: true,
							visible: (termWidth: number) => termWidth >= 60,
						};
					},
					onHandle: (h: any) => {
						handleRef = h;
					},
				},
			);
		} catch (error) {
			ctx.ui.notify(`会话历史面板打开失败: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			closeActive = undefined;
			open = false;
		}
	}

	pi.registerCommand("history", {
		description: "切换右侧会话历史侧栏 (输入关键词可直接筛选)",
		handler: async (args, ctx) => {
			const query = (args ?? "").trim();
			if (open && query) {
				ctx.ui.notify("侧栏已打开：点击面板里的搜索行后可输入关键词", "info");
				return;
			}
			await showSidebar(ctx, query);
		},
	});

	pi.registerShortcut("ctrl+shift+h", {
		description: "开关会话历史侧栏",
		handler: async (ctx) => {
			await showSidebar(ctx);
		},
	});

	// Diagnostics: report how many history entries map onto rendered transcript components.
	pi.registerCommand("history-debug", {
		description: "检查会话历史侧栏能否定位到消息 (诊断)",
		handler: async (_args, ctx) => {
			const items = collectItems(ctx);
			await ctx.ui.custom<void>(
				(tui: AnyTui, _theme: SidebarTheme, _keybindings: unknown, done: (value?: void) => void) => {
					const { scroll, document } = resolveTranscript(tui);
					const terminalWidth = tui?.terminal?.columns ?? 80;
					const width = scroll && typeof scroll.getContentWidth === "function" ? scroll.getContentWidth(terminalWidth) : terminalWidth;
					const scan = document ? scanTranscript(document, width) : { y: 0, offsets: new Map<string, number>() };
					const located = items.filter((item) => scan.offsets.has(item.id)).length;
					const actual = document ? heightOf(document, width) : 0;
					const missing = items.filter((item) => !scan.offsets.has(item.id)).map((item) => `${item.role}@${item.time}`).slice(0, 6);
					ctx.ui.notify(
						`历史 ${items.length} 条 · 可定位 ${located} 条 · 行高 计算 ${scan.y}/实际 ${actual} · 滚动视图 ${scroll ? "有" : "无"} · 宽 ${width}` +
							(missing.length ? ` · 缺: ${missing.join(", ")}` : ""),
						"info",
					);
					done();
					return { render: () => [""], invalidate() {} } as any;
				},
				{ overlay: true, overlayOptions: { anchor: "top-right", width: 1, maxHeight: 1 } },
			);
		},
	});

}
