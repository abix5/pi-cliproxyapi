// Overlay picker for /cliproxy.
//
// Layout:
//   Built-in providers
//     - <name>   N/total  ▾
//        [x] model-id  · subtitle
//        ...
//   Custom providers
//     - <slug>   N models  ▾
//        ── assigned ──
//          [x] model-id  · suggested:<origin>
//        ── available (not in another group) ──
//        suggested:<origin>
//          [ ] model-id
//        ...
//     + New custom provider…
//   Save & apply
//   Cancel
//
// Model exclusivity: a model assigned to a custom provider is REMOVED from
// the "available" section of every other custom provider. Built-in
// providers are independent of this exclusivity (they are routed to native
// Pi providers, not into the same pool).

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import {
	type Component,
	getKeybindings,
	Input,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { withProviderPrefix } from "./compat.ts";
import type { CustomProviderModelConfig, ProxyConfig } from "./config.ts";
import type { Discovery, DiscoveryCustomEntry } from "./fetch-models.ts";

interface Theme {
	fg(name: string, s: string): string;
	bold(s: string): string;
}

interface OverlayTui {
	requestRender(): void;
	rows?: number;
	cols?: number;
}

// --------------------------------------------------------------------------- public entry

export async function runPicker(
	ctx: ExtensionCommandContext,
	cfg: ProxyConfig,
	discovery: Discovery,
	opts: { readOnly?: boolean; title?: string } = {},
): Promise<ProxyConfig | null> {
	if (!ctx.hasUI) {
		ctx.ui.notify("interactive UI required for /cliproxy", "warning");
		return null;
	}
	const draft: ProxyConfig = structuredClone(cfg);

	return ctx.ui.custom<ProxyConfig | null>(
		(tui, theme, _kb, done) =>
			buildPicker(
				tui as unknown as OverlayTui,
				theme as unknown as Theme,
				draft,
				discovery,
				ctx,
				opts,
				done,
			),
		{
			overlay: true,
			overlayOptions: { width: 140, maxHeight: "92%" },
		},
	);
}

// --------------------------------------------------------------------------- row model

type Row =
	| { kind: "section"; id: string; label: string }
	| {
			kind: "provider";
			id: string;
			providerKind: "builtin" | "custom";
			providerName: string;
			label: string;
			subtitle?: string;
			selectedCount: number;
			totalCount: number;
			expanded: boolean;
	  }
	| { kind: "subheader"; id: string; label: string }
	| {
			kind: "model";
			id: string;
			providerKind: "builtin" | "custom";
			providerName: string;
			modelId: string;
			label: string;
			subtitle?: string;
			checked: boolean;
	  }
	| {
			kind: "action";
			id: string;
			label: string;
			action: "save" | "cancel" | "new-custom";
	  };

// --------------------------------------------------------------------------- picker

function buildPicker(
	tui: OverlayTui,
	theme: Theme,
	cfg: ProxyConfig,
	discovery: Discovery,
	ctx: ExtensionCommandContext,
	opts: { readOnly?: boolean; title?: string },
	done: (v: ProxyConfig | null) => void,
): Component & { handleInput(data: string): void } {
	const readOnly = opts.readOnly === true;
	const expanded = new Set<string>();
	const builtinCandidates = collectBuiltinCandidates(discovery);

	// Auto-expand providers that already have selections.
	for (const name of Object.keys(cfg.builtinProviders)) {
		if ((cfg.builtinProviders[name]?.models?.length ?? 0) > 0) {
			expanded.add(`builtin:${name}`);
		}
	}
	for (const name of Object.keys(cfg.customProviders)) {
		expanded.add(`custom:${name}`);
	}

	let cursorRowId: string | null = null;
	let scrollOffset = 0;
	let lastRenderHeight = 20;

	// ----- compute: which custom-pool models are claimed by which provider
	const claimedBy = (): Map<string, string> => {
		const m = new Map<string, string>();
		for (const [slug, p] of Object.entries(cfg.customProviders)) {
			for (const mm of p.models) m.set(mm.id, slug);
		}
		return m;
	};

	const customPoolById = new Map(discovery.customPool.map((m) => [m.id, m]));

	const rebuildRows = (): Row[] => {
		const rows: Row[] = [];
		const claim = claimedBy();

		// ── Built-in providers ───────────────────────────────────────────────
		rows.push({
			kind: "section",
			id: "sec:builtin",
			label: "Built-in providers",
		});
		if (builtinCandidates.length === 0) {
			rows.push({
				kind: "subheader",
				id: "sub:no-builtin",
				label: "(no overlap with proxy model list)",
			});
		}
		for (const c of builtinCandidates) {
			const cfgEntry = cfg.builtinProviders[c.name];
			const selected = new Set(cfgEntry?.models ?? []);
			const selectedCount = c.models.filter((m) => selected.has(m.id)).length;
			const provId = `builtin:${c.name}`;
			rows.push({
				kind: "provider",
				id: provId,
				providerKind: "builtin",
				providerName: c.name,
				label: c.name,
				subtitle: c.api,
				selectedCount,
				totalCount: c.models.length,
				expanded: expanded.has(provId),
			});
			if (expanded.has(provId)) {
				for (const m of c.models) {
					rows.push({
						kind: "model",
						id: `${provId}:${m.id}`,
						providerKind: "builtin",
						providerName: c.name,
						modelId: m.id,
						label: m.id,
						subtitle: m.name && m.name !== m.id ? m.name : undefined,
						checked: selected.has(m.id),
					});
				}
			}
		}

		// ── Custom providers ─────────────────────────────────────────────────
		rows.push({ kind: "section", id: "sec:custom", label: "Custom providers" });

		const customNames = Object.keys(cfg.customProviders).sort();
		if (customNames.length === 0) {
			rows.push({
				kind: "subheader",
				id: "sub:no-custom",
				label:
					"(none yet \u2014 create one with \u201c+ New custom provider\u2026\u201d below)",
			});
		}
		for (const slug of customNames) {
			const p = cfg.customProviders[slug]!;
			const provId = `custom:${slug}`;
			const isExpanded = expanded.has(provId);
			rows.push({
				kind: "provider",
				id: provId,
				providerKind: "custom",
				providerName: slug,
				label: slug,
				subtitle: `${p.api} \u00b7 ${p.models.length} model${p.models.length === 1 ? "" : "s"}`,
				selectedCount: p.models.length,
				totalCount: p.models.length,
				expanded: isExpanded,
			});
			if (!isExpanded) continue;

			// assigned models
			if (p.models.length > 0) {
				rows.push({
					kind: "subheader",
					id: `${provId}:sub:assigned`,
					label: "assigned",
				});
				for (const m of p.models) {
					const src = customPoolById.get(m.id);
					const origin = src?.suggestedProvider;
					const subtitle = src
						? origin && origin !== slug
							? `suggested: ${origin}  \u00b7  owned_by=${src.ownedBy}`
							: `owned_by=${src.ownedBy}`
						: "(not present on proxy right now)";
					rows.push({
						kind: "model",
						id: `${provId}:${m.id}`,
						providerKind: "custom",
						providerName: slug,
						modelId: m.id,
						label: m.id,
						subtitle,
						checked: true,
					});
				}
			}

			// available models, grouped by suggested origin (= server hint).
			// A model is "available" here if it is not claimed by ANY custom provider yet.
			const available = discovery.customPool.filter((m) => !claim.has(m.id));
			if (available.length > 0) {
				rows.push({
					kind: "subheader",
					id: `${provId}:sub:available`,
					label: "available (not in another group)",
				});
				const groups = new Map<string, DiscoveryCustomEntry[]>();
				for (const m of available) {
					const key = m.suggestedProvider || "misc";
					const arr = groups.get(key) ?? [];
					arr.push(m);
					groups.set(key, arr);
				}
				for (const [origin, list] of Array.from(groups.entries()).sort()) {
					rows.push({
						kind: "subheader",
						id: `${provId}:sub:origin:${origin}`,
						label: `${origin}`,
					});
					for (const m of list) {
						rows.push({
							kind: "model",
							id: `${provId}:add:${m.id}`,
							providerKind: "custom",
							providerName: slug,
							modelId: m.id,
							label: m.id,
							subtitle: `${m.name}  \u00b7  owned_by=${m.ownedBy}`,
							checked: false,
						});
					}
				}
			} else if (p.models.length === 0) {
				rows.push({
					kind: "subheader",
					id: `${provId}:sub:empty`,
					label: "(no available models left in the pool)",
				});
			}
		}

		if (!readOnly) {
			rows.push({
				kind: "action",
				id: "act:new-custom",
				label: "+ New custom provider\u2026",
				action: "new-custom",
			});
		}

		// ── Actions ──────────────────────────────────────────────────────────
		rows.push({ kind: "section", id: "sec:actions", label: "" });
		if (readOnly) {
			rows.push({
				kind: "action",
				id: "act:close",
				label: "Close",
				action: "cancel",
			});
		} else {
			rows.push({
				kind: "action",
				id: "act:save",
				label: "Save & apply",
				action: "save",
			});
			rows.push({
				kind: "action",
				id: "act:cancel",
				label: "Cancel (discard changes)",
				action: "cancel",
			});
		}
		return rows;
	};

	let rows = rebuildRows();
	const firstSelectable = rows.findIndex(isSelectable);
	cursorRowId = firstSelectable >= 0 ? rows[firstSelectable]!.id : null;

	const indexOfCursor = (): number => {
		if (!cursorRowId) return 0;
		const idx = rows.findIndex((r) => r.id === cursorRowId);
		return idx >= 0 ? idx : 0;
	};

	const moveCursor = (delta: number): void => {
		let idx = indexOfCursor();
		const dir = delta > 0 ? 1 : -1;
		let steps = Math.abs(delta);
		while (steps > 0) {
			idx += dir;
			if (idx < 0 || idx >= rows.length) {
				idx -= dir;
				break;
			}
			if (isSelectable(rows[idx]!)) steps--;
		}
		cursorRowId = rows[idx]!.id;
	};

	const ensureCursorVisible = (height: number): void => {
		const visible = Math.max(1, height - 2);
		const idx = indexOfCursor();
		if (idx < scrollOffset) scrollOffset = idx;
		else if (idx >= scrollOffset + visible) scrollOffset = idx - visible + 1;
		const max = Math.max(0, rows.length - visible);
		if (scrollOffset > max) scrollOffset = max;
		if (scrollOffset < 0) scrollOffset = 0;
	};

	const onSpace = (): void => {
		if (readOnly) return;
		const r = rows[indexOfCursor()];
		if (!r) return;
		if (r.kind === "model") {
			toggleModel(cfg, customPoolById, r);
			rows = rebuildRows();
			// after toggle the row id may move (assigned -> available section
			// changes the id from `${provId}:add:${modelId}` to `${provId}:${modelId}`),
			// so anchor to the closest still-existing row of the same model.
			const candidates = [
				`${r.providerKind}:${r.providerName}:${r.modelId}`,
				`${r.providerKind}:${r.providerName}:add:${r.modelId}`,
			];
			for (const id of candidates) {
				if (rows.some((row) => row.id === id)) {
					cursorRowId = id;
					break;
				}
			}
		} else if (r.kind === "provider") {
			// space on a provider header — built-in: toggle ALL; custom: ignore
			// (we want explicit per-model control for custom groups so the
			// "available pool" stays predictable).
			if (r.providerKind === "builtin") {
				toggleBuiltinAll(cfg, r, builtinCandidates);
				rows = rebuildRows();
				cursorRowId = r.id;
			}
		}
	};

	const onEnter = async (): Promise<void> => {
		const r = rows[indexOfCursor()];
		if (!r) return;
		if (r.kind === "provider") {
			const id = r.id;
			if (expanded.has(id)) expanded.delete(id);
			else expanded.add(id);
			rows = rebuildRows();
			cursorRowId = id;
		} else if (r.kind === "action") {
			if (r.action === "save") {
				done(cfg);
				return;
			}
			if (r.action === "cancel") {
				done(null);
				return;
			}
			if (r.action === "new-custom") {
				const name = await promptNewProviderName(
					ctx,
					cfg.proxy.providerPrefix,
				);
				if (name) {
					if (!cfg.customProviders[name]) {
						cfg.customProviders[name] = {
							api: "openai-completions",
							models: [],
						};
					}
					expanded.add(`custom:${name}`);
					rows = rebuildRows();
					cursorRowId = `custom:${name}`;
				}
				tui.requestRender();
				return;
			}
		} else if (r.kind === "model") {
			onSpace();
		}
	};

	const onDelete = (): void => {
		if (readOnly) return;
		const r = rows[indexOfCursor()];
		if (!r || r.kind !== "provider" || r.providerKind !== "custom") return;
		delete cfg.customProviders[r.providerName];
		expanded.delete(r.id);
		rows = rebuildRows();
		const firstIdx = rows.findIndex(isSelectable);
		cursorRowId = firstIdx >= 0 ? rows[firstIdx]!.id : null;
	};

	return {
		render(width: number): string[] {
			lastRenderHeight = Math.max(
				10,
				Math.min(rows.length + 2, (tui.rows ?? 40) - 6),
			);
			ensureCursorVisible(lastRenderHeight);
			const inner = Math.max(40, width - 2);
			const visible = Math.max(1, lastRenderHeight - 2);
			const slice = rows.slice(scrollOffset, scrollOffset + visible);
			const cursorIdx = indexOfCursor();

			const title =
				opts.title ?? (readOnly ? " /cliproxy-list " : " /cliproxy ");
			const titleBar = theme.fg(
				"borderAccent",
				`\u256d\u2500 ${theme.bold(theme.fg("accent", title))}${"\u2500".repeat(Math.max(0, inner - visibleWidth(title) - 4))}\u256e`,
			);
			const hint = readOnly
				? " \u2191\u2193 navigate  \u21b5 expand  q/esc close "
				: " \u2191\u2193 navigate  \u21b5 expand/save  space toggle  delete remove group  q/esc cancel ";
			const counter = ` ${cursorIdx + 1}/${rows.length} `;
			const fill = "\u2500".repeat(
				Math.max(0, inner - visibleWidth(hint) - visibleWidth(counter) - 4),
			);
			const footerBar = theme.fg(
				"borderAccent",
				`\u2570\u2500${theme.fg("dim", hint)}${fill}${theme.fg("muted", counter)}\u2500\u256f`,
			);
			const side = theme.fg("borderAccent", "\u2502");
			const out: string[] = [titleBar];
			for (let i = 0; i < slice.length; i++) {
				const row = slice[i]!;
				const abs = scrollOffset + i;
				const isCursor = abs === cursorIdx;
				out.push(
					`${side} ${pad(renderRow(theme, row, isCursor), inner - 2)} ${side}`,
				);
			}
			while (out.length < visible + 1) {
				out.push(`${side} ${pad("", inner - 2)} ${side}`);
			}
			out.push(footerBar);
			return out;
		},
		invalidate(): void {
			/* stateless */
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (
				kb.matches(data, "tui.select.cancel") ||
				matchesKey(data, "q") ||
				matchesKey(data, "shift+q")
			) {
				done(null);
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				void onEnter().then(() => tui.requestRender());
				return;
			}
			if (matchesKey(data, "space")) {
				onSpace();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
				onDelete();
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "up") || matchesKey(data, "k")) {
				moveCursor(-1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "down") || matchesKey(data, "j")) {
				moveCursor(1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "pageUp") || matchesKey(data, "b")) {
				moveCursor(-Math.max(1, lastRenderHeight - 3));
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "pageDown") || matchesKey(data, "f")) {
				moveCursor(Math.max(1, lastRenderHeight - 3));
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "home") || matchesKey(data, "g")) {
				const idx = rows.findIndex(isSelectable);
				if (idx >= 0) cursorRowId = rows[idx]!.id;
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
				for (let i = rows.length - 1; i >= 0; i--) {
					if (isSelectable(rows[i]!)) {
						cursorRowId = rows[i]!.id;
						break;
					}
				}
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "right") || matchesKey(data, "l")) {
				const r = rows[indexOfCursor()];
				if (r?.kind === "provider" && !expanded.has(r.id)) {
					expanded.add(r.id);
					rows = rebuildRows();
					cursorRowId = r.id;
					tui.requestRender();
				}
				return;
			}
			if (matchesKey(data, "left") || matchesKey(data, "h")) {
				const r = rows[indexOfCursor()];
				if (r?.kind === "provider" && expanded.has(r.id)) {
					expanded.delete(r.id);
					rows = rebuildRows();
					cursorRowId = r.id;
					tui.requestRender();
				}
				return;
			}
		},
	};
}

function isSelectable(r: Row): boolean {
	return r.kind === "provider" || r.kind === "model" || r.kind === "action";
}

// --------------------------------------------------------------------------- row rendering

function renderRow(theme: Theme, row: Row, isCursor: boolean): string {
	const cur = isCursor ? theme.fg("accent", "\u25b6 ") : "  ";
	if (row.kind === "section") {
		return theme.bold(theme.fg("accent", `\u2501 ${row.label} `));
	}
	if (row.kind === "subheader") {
		return `    ${theme.fg("muted", `\u00b7 ${row.label}`)}`;
	}
	if (row.kind === "provider") {
		const arrow = row.expanded ? "\u25be" : "\u25b8";
		const counts = `${row.selectedCount}/${row.totalCount}`;
		const stats =
			row.selectedCount > 0
				? theme.fg("success", `\u25cf ${counts}`)
				: theme.fg("dim", `\u25cb ${counts}`);
		const name = isCursor
			? theme.bold(theme.fg("accent", row.label))
			: theme.bold(row.label);
		const sub = row.subtitle ? `  ${theme.fg("dim", row.subtitle)}` : "";
		return `${cur}${arrow} ${name}  ${stats}${sub}`;
	}
	if (row.kind === "model") {
		const box = row.checked
			? theme.fg("success", "[\u2713]")
			: theme.fg("dim", "[ ]");
		const idStr = isCursor ? theme.fg("accent", row.label) : row.label;
		const sub = row.subtitle ? `  ${theme.fg("dim", row.subtitle)}` : "";
		return `${cur}     ${box}  ${idStr}${sub}`;
	}
	const icon =
		row.action === "save"
			? theme.fg("success", "\u2714")
			: row.action === "new-custom"
				? theme.fg("accent", "\u002b")
				: theme.fg("error", "\u2716");
	const label = isCursor
		? theme.bold(theme.fg("accent", row.label))
		: theme.fg("muted", row.label);
	return `${cur}${icon}  ${label}`;
}

function pad(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

// --------------------------------------------------------------------------- mutation

function toggleModel(
	cfg: ProxyConfig,
	customPoolById: Map<string, DiscoveryCustomEntry>,
	row: Extract<Row, { kind: "model" }>,
): void {
	if (row.providerKind === "builtin") {
		const cur = cfg.builtinProviders[row.providerName] ?? {
			enabled: true,
			models: [],
		};
		const selected = new Set(cur.models);
		if (selected.has(row.modelId)) selected.delete(row.modelId);
		else selected.add(row.modelId);
		cfg.builtinProviders[row.providerName] = {
			enabled: selected.size > 0,
			apiOverride: cur.apiOverride ?? null,
			models: Array.from(selected).sort(),
		};
		return;
	}
	// custom: toggle membership in this slug.
	const slug = row.providerName;
	const cur = cfg.customProviders[slug] ?? {
		api: customPoolById.get(row.modelId)?.api ?? "openai-completions",
		models: [] as CustomProviderModelConfig[],
	};
	const idx = cur.models.findIndex((m) => m.id === row.modelId);
	if (idx >= 0) {
		cur.models.splice(idx, 1);
	} else {
		const src = customPoolById.get(row.modelId);
		cur.models.push(
			src
				? {
						id: src.id,
						name: src.name,
						contextWindow: src.contextWindow,
						maxTokens: src.maxTokens,
						reasoning: src.reasoning,
						cost: src.cost,
					}
				: { id: row.modelId },
		);
	}
	// Keep group even if empty so user can add models later; only delete when
	// user explicitly removes the group (delete key on header).
	cfg.customProviders[slug] = cur;
}

function toggleBuiltinAll(
	cfg: ProxyConfig,
	row: Extract<Row, { kind: "provider" }>,
	builtinCandidates: ReturnType<typeof collectBuiltinCandidates>,
): void {
	const cand = builtinCandidates.find((c) => c.name === row.providerName);
	if (!cand) return;
	const all = cand.models.map((m) => m.id);
	const cur = cfg.builtinProviders[row.providerName];
	const allOn = cur && cur.models.length === all.length;
	cfg.builtinProviders[row.providerName] = {
		enabled: !allOn,
		apiOverride: cur?.apiOverride ?? null,
		models: allOn ? [] : all.sort(),
	};
}

// --------------------------------------------------------------------------- discovery aggregation

interface BuiltinCandidate {
	name: string;
	api: Api;
	models: Array<{ id: string; name: string }>;
}

function collectBuiltinCandidates(discovery: Discovery): BuiltinCandidate[] {
	const proxyIds = new Set<string>();
	for (const p of discovery.builtinProviders)
		for (const m of p.models) proxyIds.add(m.id);
	for (const m of discovery.customPool) proxyIds.add(m.id);

	const out: BuiltinCandidate[] = [];
	for (const name of getProviders()) {
		try {
			const models = getModels(name as Parameters<typeof getModels>[0]);
			const matched = models.filter((m) => proxyIds.has(m.id));
			if (matched.length === 0) continue;
			out.push({
				name,
				api: matched[0]!.api,
				models: matched.map((m) => ({ id: m.id, name: m.name })),
			});
		} catch {
			/* ignore */
		}
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

// --------------------------------------------------------------------------- new provider prompt

async function promptNewProviderName(
	ctx: ExtensionCommandContext,
	prefix: string | undefined,
): Promise<string | null> {
	const suggestion = withProviderPrefix(prefix, "group");
	return ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) =>
			buildNamePrompt(
				tui as unknown as { requestRender(): void },
				theme as unknown as Theme,
				suggestion,
				done,
			),
		{
			overlay: true,
			overlayOptions: { width: 80, maxHeight: "40%" },
		},
	);
}

function buildNamePrompt(
	tui: { requestRender(): void },
	theme: Theme,
	suggestion: string,
	done: (v: string | null) => void,
): Component & { handleInput(data: string): void } {
	const input = new Input();
	// Don't pre-fill if we have no prefix suggestion — force the user to type.
	if (suggestion) input.setValue(suggestion);
	input.focused = true;
	let error: string | null = null;

	input.onSubmit = (raw) => {
		const v = raw.trim();
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(v)) {
			error = "letters / digits / dot / dash / underscore only";
			tui.requestRender();
			return;
		}
		done(v);
	};
	input.onEscape = () => done(null);

	return {
		render(width: number): string[] {
			const inner = Math.max(40, width - 2);
			const titleBar = theme.fg(
				"borderAccent",
				`\u256d\u2500 ${theme.bold(theme.fg("accent", " new custom provider "))}${"\u2500".repeat(Math.max(0, inner - 24))}\u256e`,
			);
			const hint = theme.fg(
				"dim",
				suggestion
					? `name shown in /model picker, e.g. ${suggestion}, ${suggestion.replace(/group$/, "tools")}`
					: "name shown in /model picker (letters / digits / dot / dash / underscore)",
			);
			const side = theme.fg("borderAccent", "\u2502");
			const errLine = error
				? pad(theme.fg("error", `! ${error}`), inner - 2)
				: pad(
						theme.fg("dim", "enter = create  \u00b7  esc = cancel"),
						inner - 2,
					);
			const inputLines = input.render(inner - 4);
			const out: string[] = [titleBar];
			out.push(`${side} ${pad(hint, inner - 2)} ${side}`);
			out.push(`${side} ${pad("", inner - 2)} ${side}`);
			for (const ln of inputLines) {
				out.push(
					`${side} ${pad(theme.fg("accent", `> ${ln}`), inner - 2)} ${side}`,
				);
			}
			out.push(`${side} ${pad("", inner - 2)} ${side}`);
			out.push(`${side} ${errLine} ${side}`);
			out.push(
				theme.fg("borderAccent", `\u2570${"\u2500".repeat(inner)}\u256f`),
			);
			return out;
		},
		invalidate(): void {
			input.invalidate();
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
				done(null);
				return;
			}
			error = null;
			input.handleInput(data);
			tui.requestRender();
		},
	};
}
