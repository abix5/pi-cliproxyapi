// Read-only scrollable overlay used by /cliproxy-list, /cliproxy-usage, /cliproxy-doctor.
//
// Pure presentational — never touches the agent session or context. The
// caller may supply boolean "toggles" (one keystroke each) that re-render the
// body when flipped. The overlay shell handles scrolling and dismissal.
//
// Built-in keys:
//   ↑ / k         scroll up one line   (held = repeat via Kitty kbd protocol)
//   ↓ / j         scroll down one line
//   PageUp / b    scroll up one page
//   PageDown / f  scroll down one page (also Space)
//   Home / g      jump to top
//   End / G       jump to bottom
//   Esc / q / Enter / Ctrl+C  close
//
// Plus any caller-defined toggles.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";

interface Theme {
	fg(name: string, s: string): string;
	bold(s: string): string;
}

interface OverlayTui {
	requestRender(): void;
	rows?: number;
	cols?: number;
}

export interface OverlayToggle {
	/** Single key id passed to matchesKey() (e.g. "d", "v"). */
	key: string;
	/** Short hint shown in the footer (e.g. "d disabled"). */
	hint: string;
	/** Initial state. Defaults to false. */
	initial?: boolean;
}

export interface OverlayOptions {
	title: string;
	/** Re-rendered every time a toggle flips. Receives current toggle state. */
	render: (state: Record<string, boolean>) => string;
	toggles?: OverlayToggle[];
}

interface BuildProps extends OverlayOptions {
	done: (value: void) => void;
	theme: Theme;
}

function buildOverlay(
	tui: OverlayTui,
	props: BuildProps,
): Component & { handleInput(data: string): void } {
	const state: Record<string, boolean> = {};
	for (const t of props.toggles ?? []) state[t.key] = t.initial ?? false;
	let lines: string[] = props.render(state).split("\n");
	let offset = 0;
	let lastRenderHeight = 20;
	let lastRenderWidth = 80;

	const t = props.theme;

	const recompute = (): void => {
		lines = props.render(state).split("\n");
		const visible = Math.max(1, lastRenderHeight - 2);
		const max = Math.max(0, lines.length - visible);
		if (offset > max) offset = max;
	};

	const renderFrame = (width: number, height: number): string[] => {
		const inner = Math.max(10, width - 2);
		const visible = Math.max(1, height - 2);
		const total = lines.length;
		const maxOffset = Math.max(0, total - visible);
		if (offset > maxOffset) offset = maxOffset;
		const slice = lines.slice(offset, offset + visible);
		while (slice.length < visible) slice.push("");
		const pct =
			total > visible
				? Math.min(100, Math.round(((offset + visible) / total) * 100))
				: 100;
		const titleBar = formatTitleBar(t, props.title, inner);
		const footerBar = formatFooterBar(t, {
			from: offset + 1,
			to: Math.min(total, offset + visible),
			total,
			pct,
			width: inner,
			toggles: (props.toggles ?? []).map((tg) => ({
				hint: tg.hint,
				active: state[tg.key] === true,
			})),
		});
		const sideL = t.fg("borderAccent", "│");
		const sideR = t.fg("borderAccent", "│");
		const out: string[] = [titleBar];
		for (const ln of slice) {
			out.push(`${sideL} ${padRight(ln, inner - 2)} ${sideR}`);
		}
		out.push(footerBar);
		return out;
	};

	return {
		render(width: number): string[] {
			lastRenderWidth = width;
			lastRenderHeight = Math.max(
				10,
				Math.min(lines.length + 2, (tui.rows ?? 40) - 6),
			);
			return renderFrame(lastRenderWidth, lastRenderHeight);
		},
		invalidate(): void {
			/* stateless render */
		},
		handleInput(data: string): void {
			const visible = Math.max(1, lastRenderHeight - 2);
			const max = Math.max(0, lines.length - visible);
			const kb = getKeybindings();

			// Caller toggles run first so they shadow letter-key scroll bindings.
			for (const tg of props.toggles ?? []) {
				if (matchesKey(data, tg.key as never)) {
					state[tg.key] = !state[tg.key];
					recompute();
					tui.requestRender();
					return;
				}
			}

			if (
				kb.matches(data, "tui.select.cancel") ||
				matchesKey(data, "q") ||
				matchesKey(data, "shift+q") ||
				matchesKey(data, "enter") ||
				matchesKey(data, "return")
			) {
				props.done();
				return;
			}
			let next = offset;
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				next = Math.max(0, offset - 1);
			} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
				next = Math.min(max, offset + 1);
			} else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
				next = Math.max(0, offset - visible);
			} else if (
				matchesKey(data, "pageDown") ||
				matchesKey(data, "f") ||
				matchesKey(data, "space")
			) {
				next = Math.min(max, offset + visible);
			} else if (matchesKey(data, "home") || matchesKey(data, "g")) {
				next = 0;
			} else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
				next = max;
			} else {
				return;
			}
			if (next !== offset) {
				offset = next;
				tui.requestRender();
			}
		},
	};
}

// --------------------------------------------------------------------------- chrome helpers

function formatTitleBar(theme: Theme, title: string, inner: number): string {
	const label = ` ${title} `;
	const leftSep = "╭─";
	const rightFill = inner - visibleWidth(label) - visibleWidth(leftSep) - 2;
	const fill = "─".repeat(Math.max(0, rightFill));
	return theme.fg(
		"borderAccent",
		`${leftSep}${theme.bold(theme.fg("accent", label))}${theme.fg("borderAccent", fill)}╮`,
	);
}

function formatFooterBar(
	theme: Theme,
	opts: {
		from: number;
		to: number;
		total: number;
		pct: number;
		width: number;
		toggles: Array<{ hint: string; active: boolean }>;
	},
): string {
	const hintBase = "↑↓ · pgUp/pgDn · g/G";
	const togglesText = opts.toggles
		.map((tg) =>
			tg.active
				? theme.fg("success", `[${tg.hint}]`)
				: theme.fg("dim", tg.hint),
		)
		.join(" · ");
	const left = ` ${hintBase}${togglesText ? "  " + togglesText : ""} `;
	const right = ` ${opts.from}–${opts.to} of ${opts.total}  ${opts.pct}% `;
	const leftSep = "╰─";
	const rightSep = "╯";
	const used =
		visibleWidth(leftSep) +
		visibleWidth(rightSep) +
		visibleWidth(left) +
		visibleWidth(right);
	const filler = "─".repeat(Math.max(0, opts.width - used));
	return theme.fg(
		"borderAccent",
		`${leftSep}${theme.fg("dim", left)}${filler}${theme.fg("muted", right)}${rightSep}`,
	);
}

function padRight(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

// --------------------------------------------------------------------------- public API

/**
 * Show a scrollable overlay with optional toggles.
 *
 * If you don't need toggles, pass a string for the body and we'll wrap it.
 */
export async function showOverlay(
	ctx: ExtensionCommandContext,
	title: string,
	bodyOrOptions: string | Omit<OverlayOptions, "title">,
): Promise<void> {
	const opts: OverlayOptions =
		typeof bodyOrOptions === "string"
			? { title, render: () => bodyOrOptions }
			: { title, ...bodyOrOptions };

	if (!ctx.hasUI) {
		ctx.ui.notify(`${title}\n\n${opts.render({})}`, "info");
		return;
	}

	// Probe widest line across all toggle combinations so the overlay doesn't
	// resize as the user flips switches. With N toggles we check 2^N states,
	// but in practice we only ever pass 0-2 toggles.
	const probedWidth = probeMaxWidth(opts);
	const desiredCols = Math.min(140, Math.max(72, probedWidth + 6));

	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) =>
			buildOverlay(tui as unknown as OverlayTui, {
				...opts,
				done,
				theme: theme as unknown as Theme,
			}),
		{
			overlay: true,
			overlayOptions: {
				width: desiredCols,
				maxHeight: "80%",
			},
		},
	);
}

function probeMaxWidth(opts: OverlayOptions): number {
	const toggles = opts.toggles ?? [];
	const combos = 1 << toggles.length;
	let max = 0;
	for (let i = 0; i < combos; i++) {
		const state: Record<string, boolean> = {};
		toggles.forEach((tg, j) => {
			state[tg.key] = (i & (1 << j)) !== 0;
		});
		const body = opts.render(state);
		for (const ln of body.split("\n")) {
			const w = visibleWidth(ln);
			if (w > max) max = w;
		}
	}
	return max;
}
