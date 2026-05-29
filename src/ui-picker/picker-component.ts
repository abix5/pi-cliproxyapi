// Render + input dispatch for the three-panel picker. Kept separate from
// picker.ts so each file stays under ~300 lines.

import type { Component } from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import { frame, type FrameFooter } from "../ui-frame.ts";
import { pad } from "./render-text.ts";
import {
	renderEmpty,
	renderModelRow,
	renderNewProviderRow,
	renderPanelHeader,
	renderProviderRow,
	renderSubheader,
} from "./rows.ts";
import type {
	CatalogIndex,
	OverlayTui,
	PanelId,
	ProviderEntry,
	Theme,
} from "./types.ts";
import {
	visibleWidth,
	matchesKey,
	getKeybindings,
} from "@earendil-works/pi-tui";

export interface AssembleArgs {
	tui: OverlayTui;
	theme: Theme;
	cfg: ProxyConfig;
	readOnly?: never;
	opts?: never;
	catalog: CatalogIndex;
	getProviders: () => ProviderEntry[];
	getFocus: () => PanelId;
	setFocus: (f: PanelId) => void;
	getProviderCursor: () => number;
	getAssignedCursor: () => number;
	getPoolCursor: () => number;
	getProviderScroll: () => number;
	setProviderScroll: (v: number) => void;
	getAssignedScroll: () => number;
	setAssignedScroll: (v: number) => void;
	getPoolScroll: () => number;
	setPoolScroll: (v: number) => void;
	selectedProvider: () => ProviderEntry | null;
	moveCursor: (delta: number) => void;
	onTab: (back: boolean) => void;
	onActivate: () => Promise<void>;
	onDelete: () => Promise<void>;
	ensureVisible: (cursor: number, scroll: number, visible: number) => number;
	finish: (result: ProxyConfig | null) => void;
	poolGrouper: (ids: string[]) => Array<{ label: string; ids: string[] }>;
	assignedIdsFor: (p: ProviderEntry) => string[];
	poolFor: (p: ProviderEntry) => string[];
}

export function assembleComponent(
	a: AssembleArgs,
): Component & { handleInput(data: string): void } {
	const render = (width: number): string[] => render3Panel(a, width);
	return {
		render(width: number): string[] {
			return render(width);
		},
		invalidate(): void {
			/* stateless */
		},
		handleInput(data: string): void {
			handleInput(a, data);
		},
	};
}

// --------------------------------------------------------------------------- render

function render3Panel(a: AssembleArgs, width: number): string[] {
	const { theme, tui, cfg, catalog } = a;
	const totalRows = tui.rows ?? 40;
	const height = Math.max(16, Math.min(totalRows - 6, 38));
	// frame() adds its own outer "│ … │" walls and accounts for `width` cells
	// total. So our body lines must be exactly `width - 2` cells wide.
	const inner = Math.max(70, width - 2);
	const leftW = Math.min(56, Math.max(34, Math.floor(inner * 0.4)));
	const rightW = inner - leftW - 1; // -1 for the vertical splitter
	const upperH = Math.max(5, Math.floor((height - 2) / 2));
	const lowerH = height - 2 - upperH;

	const title = " /cliproxy ";

	const prov = a.selectedProvider();
	const focus = a.getFocus();

	// Track each panel's cursor line + the run of context lines (subheaders /
	// panel-headers / blank empties) immediately above it. The context block
	// must stay visible together with the cursor so groups don't "jump" past
	// invisible owned_by labels.
	let leftCursorLine = 0;
	let leftCursorTop = 0;
	let assignedCursorLine = 0;
	let assignedCursorTop = 0;
	let poolCursorLine = 0;
	let poolCursorTop = 0;

	// LEFT
	const leftLines: string[] = [];
	leftLines.push(
		panelHeaderBar(theme, " providers ", leftW, focus === "providers"),
	);
	const providers = a.getProviders();
	for (let i = 0; i < providers.length; i++) {
		const p = providers[i]!;
		const isCursor = focus === "providers" && i === a.getProviderCursor();
		if (isCursor) {
			leftCursorLine = leftLines.length;
			leftCursorTop = leftCursorLine;
		}
		leftLines.push(
			renderProviderRow(p, cfg, {
				theme,
				width: leftW,
				isCursor,
				isFocused: focus === "providers",
			}),
		);
	}
	{
		const isCursor =
			focus === "providers" && a.getProviderCursor() === providers.length;
		if (isCursor) {
			leftCursorLine = leftLines.length;
			leftCursorTop = leftCursorLine;
		}
		leftLines.push(
			renderNewProviderRow(theme, isCursor, focus === "providers", leftW),
		);
	}

	// RIGHT TOP (assigned)
	const assignedLines: string[] = [];
	const assignedHeader = prov
		? `assigned to ${theme.bold(prov.name)}  ${theme.fg("dim", `\u00b7 ${prov.api}`)}`
		: theme.fg("dim", "no provider selected");
	assignedLines.push(
		panelHeaderBar(theme, " assigned ", rightW, focus === "assigned"),
	);
	assignedLines.push(
		renderPanelHeader(theme, assignedHeader, rightW, focus === "assigned"),
	);
	if (prov) {
		const ids = a.assignedIdsFor(prov);
		if (ids.length === 0) {
			assignedLines.push(renderEmpty(theme, "(nothing assigned yet)", rightW));
		}
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]!;
			const m = catalog.byId.get(id);
			const isCursor = focus === "assigned" && i === a.getAssignedCursor();
			if (isCursor) {
				assignedCursorLine = assignedLines.length;
				assignedCursorTop = assignedCursorLine;
			}
			const compatWarn = m ? !a.apiCompatible(prov.api, m.suggestedApi) : false;
			assignedLines.push(
				renderModelRow(id, m, "assigned", compatWarn, {
					theme,
					width: rightW,
					isCursor,
					isFocused: focus === "assigned",
				}),
			);
		}
	}

	// RIGHT BOTTOM (pool, grouped by ownedBy)
	const poolLines: string[] = [];
	poolLines.push(
		panelHeaderBar(theme, " available pool ", rightW, focus === "pool"),
	);
	if (prov) {
		const ids = a.poolFor(prov);
		if (ids.length === 0) {
			poolLines.push(renderEmpty(theme, "(no models available)", rightW));
		} else {
			let cursorIdx = 0;
			for (const grp of a.poolGrouper(ids)) {
				const groupHeaderLine = poolLines.length;
				poolLines.push(renderSubheader(theme, grp.label, rightW));
				for (let gi = 0; gi < grp.ids.length; gi++) {
					const id = grp.ids[gi]!;
					const m = catalog.byId.get(id);
					const isCursor = focus === "pool" && cursorIdx === a.getPoolCursor();
					if (isCursor) {
						poolCursorLine = poolLines.length;
						// First model of a group — pin the owned_by subheader too.
						poolCursorTop = gi === 0 ? groupHeaderLine : poolCursorLine;
					}
					const compatWarn = m
						? !a.apiCompatible(prov.api, m.suggestedApi)
						: false;
					poolLines.push(
						renderModelRow(id, m, "pool", compatWarn, {
							theme,
							width: rightW,
							isCursor,
							isFocused: focus === "pool",
						}),
					);
					cursorIdx++;
				}
			}
		}
	}

	// Scroll math. Each panel has a sticky panel-header at index 0; assigned
	// has a second sticky line for "assigned to <prov>". We keep those locked
	// at the top and only scroll the body rows below them. scrollFor() also
	// clamps so we never push the cursor past the visible area or leave a gap
	// when scrolling back to the top of a long list.
	const poolUsableH = Math.max(1, lowerH - 1); // -1 for the horizontal divider
	const leftScroll = scrollFor(
		leftCursorTop,
		leftCursorLine,
		a.getProviderScroll(),
		height - 2,
		leftLines.length,
		1,
	);
	const aScroll = scrollFor(
		focus === "assigned" ? assignedCursorTop : 0,
		focus === "assigned" ? assignedCursorLine : 0,
		a.getAssignedScroll(),
		upperH,
		assignedLines.length,
		2,
	);
	const pScroll = scrollFor(
		focus === "pool" ? poolCursorTop : 0,
		focus === "pool" ? poolCursorLine : 0,
		a.getPoolScroll(),
		poolUsableH,
		poolLines.length,
		1,
	);
	a.setProviderScroll(leftScroll);
	a.setAssignedScroll(aScroll);
	a.setPoolScroll(pScroll);

	const leftSlice = takeSlice(leftLines, leftScroll, height - 2);
	const aSlice = takeSlice(assignedLines, aScroll, upperH);
	const pSlice = takeSlice(poolLines, pScroll, lowerH);

	const vsplit = theme.fg("borderAccent", "\u2502");
	const bodyLines: string[] = [];
	for (let i = 0; i < height - 2; i++) {
		const l = pad(leftSlice[i] ?? "", leftW);
		const rRaw = i < upperH ? aSlice[i]! : pSlice[i - upperH]!;
		const r = pad(rRaw, rightW);
		bodyLines.push(`${l}${vsplit}${r}`);
	}
	const divIdx = upperH;
	if (divIdx > 0 && divIdx < height - 2) {
		const left = pad(leftSlice[divIdx] ?? "", leftW);
		const horiz = theme.fg("borderAccent", "\u2500".repeat(rightW));
		bodyLines[divIdx] = `${left}${vsplit}${horiz}`;
	}

	return frame(theme, {
		width,
		title,
		lines: bodyLines,
		footer: footerFor(focus),
	});
}

function takeSlice(lines: string[], scroll: number, count: number): string[] {
	const s = lines.slice(scroll, scroll + count);
	while (s.length < count) s.push("");
	return s;
}

/**
 * Scroll a list so the cursor line stays visible inside `visible` rows.
 *
 * Two cursor coords:
 *   - cursorTop: the highest line that must remain visible (usually a group
 *     subheader sitting right above the cursor on the first row of a group).
 *   - cursorBottom: the cursor row itself.
 *
 * Constraints:
 *   - Lines [0..stickyCount) are panel headers we want pinned at the top, so
 *     `scroll` is at most `total - visible` AND at most `cursorTop -
 *     stickyCount` when the cursor block is below them.
 *   - When the block fits entirely inside the visible window we keep `prev`
 *     to avoid jitter.
 *   - We never leave a gap of empty rows above (the "3 missing rows when
 *     scrolling back up" bug) or push the cursor below the panel (the
 *     "cursor goes 3 lines below" bug).
 */
function scrollFor(
	cursorTop: number,
	cursorBottom: number,
	prev: number,
	visible: number,
	total: number,
	stickyCount: number,
): number {
	if (total <= visible) return 0;
	const maxScroll = Math.max(0, total - visible);
	if (cursorBottom < stickyCount) return 0;
	let scroll = Math.max(0, Math.min(prev, maxScroll));
	const topRow = scroll + stickyCount;
	if (cursorTop < topRow) {
		scroll = Math.max(0, cursorTop - stickyCount);
	}
	const bottomRow = scroll + visible - 1;
	if (cursorBottom > bottomRow) {
		scroll = Math.min(maxScroll, cursorBottom - (visible - 1));
	}
	return scroll;
}

function panelHeaderBar(
	theme: Theme,
	label: string,
	width: number,
	isFocused: boolean,
): string {
	const bar = isFocused
		? theme.bold(theme.fg("accent", label))
		: theme.fg("muted", label);
	const fill = theme.fg(
		"borderAccent",
		"\u2500".repeat(Math.max(0, width - visibleWidth(label) - 1)),
	);
	return pad(`${bar}${fill}`, width);
}

function footerFor(focus: PanelId): FrameFooter {
	const hint =
		" tab \u2194 panel  \u2191\u2193 nav  \u21b5/space move  d remove group  s save  q cancel ";
	return { hint, badge: ` focus: ${focus} ` };
}

// --------------------------------------------------------------------------- input

function handleInput(a: AssembleArgs, data: string): void {
	const { tui, finish, cfg } = a;
	const kb = getKeybindings();
	if (
		kb.matches(data, "tui.select.cancel") ||
		matchesKey(data, "q") ||
		matchesKey(data, "shift+q") ||
		matchesKey(data, "escape")
	) {
		finish(null);
		return;
	}
	if (matchesKey(data, "tab")) {
		a.onTab(false);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "shift+tab")) {
		a.onTab(true);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "s")) {
		finish(cfg);
		return;
	}
	if (
		matchesKey(data, "enter") ||
		matchesKey(data, "return") ||
		matchesKey(data, "space")
	) {
		void a.onActivate().then(() => tui.requestRender());
		return;
	}
	if (
		matchesKey(data, "d") ||
		matchesKey(data, "delete") ||
		matchesKey(data, "backspace")
	) {
		void a.onDelete();
		return;
	}
	if (matchesKey(data, "up") || matchesKey(data, "k")) {
		a.moveCursor(-1);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "down") || matchesKey(data, "j")) {
		a.moveCursor(1);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
		a.moveCursor(-8);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
		a.moveCursor(8);
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "left") || matchesKey(data, "h")) {
		a.setFocus("providers");
		tui.requestRender();
		return;
	}
	if (matchesKey(data, "right") || matchesKey(data, "l")) {
		const f = a.getFocus();
		if (f === "providers") a.setFocus("assigned");
		else if (f === "assigned") a.setFocus("pool");
		tui.requestRender();
		return;
	}
}

// Provide a tiny apiCompatible binding so we can call it from render.
// The grouping/api functions are passed in directly via AssembleArgs.
declare module "./picker-component.ts" {
	interface AssembleArgs {
		apiCompatible: (provApi: string, modelApi: string) => boolean;
	}
}
