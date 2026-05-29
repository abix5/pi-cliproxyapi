// Three-panel picker: state, navigation, render, input dispatch.
//
// Layout (drawn by render()):
//   \u250c\u2500 providers \u2500\u252c\u2500 assigned to <prov> \u2500\u2510
//   \u2502 list ...     \u2502 list ...               \u2502
//   \u2502              \u251c\u2500 available pool \u2500\u2500\u2500\u2500\u2500\u2524
//   \u2502              \u2502 grouped by owned_by   \u2502
//   \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";

import type { ProxyConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { buildCatalog } from "./catalog.ts";
import {
	apiCompatible,
	assignedIdsFor,
	attachModel,
	detachModel,
	groupPoolByOwnedBy,
	poolFor,
} from "./mutate.ts";
import { collectProviders } from "./providers.ts";
import { confirmRemoveProvider } from "./prompt-confirm.ts";
import { promptNewProviderName } from "./prompt-name.ts";
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

interface RightRow {
	kind: "header" | "sub" | "model" | "empty";
	label?: string;
	// model fields
	id?: string;
	side?: "assigned" | "pool";
	compatWarn?: boolean;
	/** index into the linear cursor list (skipping non-cursor rows). */
	cursorIdx?: number;
}

export function buildPicker(
	tui: OverlayTui,
	theme: Theme,
	cfg: ProxyConfig,
	discovery: Discovery,
	ctx: ExtensionCommandContext,
	done: (v: ProxyConfig | null) => void,
): Component & { handleInput(data: string): void } {
	const catalog: CatalogIndex = buildCatalog(discovery);
	let providers: ProviderEntry[] = collectProviders(cfg, catalog);

	let focus: PanelId = "providers";
	let providerCursor = 0;
	let assignedCursor = 0;
	let poolCursor = 0;
	let providerScroll = 0;
	let assignedScroll = 0;
	let poolScroll = 0;
	const finish = (result: ProxyConfig | null): void => {
		done(result);
	};

	const selectedProvider = (): ProviderEntry | null => {
		if (providers.length === 0) return null;
		const idx = Math.max(0, Math.min(providerCursor, providers.length - 1));
		return providers[idx] ?? null;
	};

	const refresh = (): void => {
		providers = collectProviders(cfg, catalog);
		const maxProv = Math.max(0, providers.length); // +1 for "+ new" pseudo row
		if (providerCursor > maxProv) providerCursor = maxProv;
		const prov = selectedProvider();
		if (prov) {
			const aLen = assignedIdsFor(cfg, prov).length;
			const pLen = poolFor(cfg, prov, catalog).length;
			if (assignedCursor >= aLen) assignedCursor = Math.max(0, aLen - 1);
			if (poolCursor >= pLen) poolCursor = Math.max(0, pLen - 1);
		}
	};

	const ensureVisible = (
		cursor: number,
		scroll: number,
		visible: number,
	): number => {
		if (cursor < scroll) return cursor;
		if (cursor >= scroll + visible) return cursor - visible + 1;
		return Math.max(0, scroll);
	};

	const onTab = (back: boolean): void => {
		const order: PanelId[] = ["providers", "assigned", "pool"];
		const i = order.indexOf(focus);
		focus = back
			? order[(i - 1 + order.length) % order.length]!
			: order[(i + 1) % order.length]!;
	};

	const moveCursor = (delta: number): void => {
		if (focus === "providers") {
			const total = providers.length + 1; // +1 for "+ new" pseudo row
			providerCursor = Math.max(0, Math.min(providerCursor + delta, total - 1));
			return;
		}
		const prov = selectedProvider();
		if (!prov) return;
		if (focus === "assigned") {
			const total = assignedIdsFor(cfg, prov).length;
			if (total === 0) return;
			assignedCursor = Math.max(0, Math.min(assignedCursor + delta, total - 1));
			return;
		}
		const total = poolFor(cfg, prov, catalog).length;
		if (total === 0) return;
		poolCursor = Math.max(0, Math.min(poolCursor + delta, total - 1));
	};

	const onActivate = async (): Promise<void> => {
		if (focus === "providers") {
			if (providerCursor === providers.length) {
				const name = await promptNewProviderName(ctx, cfg.proxy.providerPrefix);
				if (name && !cfg.customProviders[name]) {
					cfg.customProviders[name] = { api: "openai-completions", models: [] };
					refresh();
					providerCursor = providers.findIndex(
						(p) => p.kind === "custom" && p.name === name,
					);
					if (providerCursor < 0) providerCursor = providers.length - 1;
					focus = "pool";
				}
				tui.requestRender();
				return;
			}
			focus = "pool";
			return;
		}
		const prov = selectedProvider();
		if (!prov) return;
		if (focus === "assigned") {
			const ids = assignedIdsFor(cfg, prov);
			const id = ids[assignedCursor];
			if (!id) return;
			detachModel(cfg, prov, id);
			refresh();
			return;
		}
		const ids = poolFor(cfg, prov, catalog);
		const id = ids[poolCursor];
		if (!id) return;
		const m = catalog.byId.get(id);
		if (!m) return;
		attachModel(cfg, prov, m);
		refresh();
	};

	const onDelete = async (): Promise<void> => {
		if (focus !== "providers") return;
		const prov = selectedProvider();
		if (!prov || prov.kind !== "custom") return;
		const ok = await confirmRemoveProvider(ctx, prov.name);
		if (!ok) {
			tui.requestRender();
			return;
		}
		delete cfg.customProviders[prov.name];
		refresh();
		if (providerCursor >= providers.length)
			providerCursor = Math.max(0, providers.length - 1);
		tui.requestRender();
	};

	// Render and input split into the second half of the file.
	return assembleComponent({
		tui,
		theme,
		cfg,
		catalog,
		getProviders: () => providers,
		getFocus: () => focus,
		setFocus: (f: PanelId) => {
			focus = f;
		},
		getProviderCursor: () => providerCursor,
		getAssignedCursor: () => assignedCursor,
		getPoolCursor: () => poolCursor,
		getProviderScroll: () => providerScroll,
		setProviderScroll: (v: number) => {
			providerScroll = v;
		},
		getAssignedScroll: () => assignedScroll,
		setAssignedScroll: (v: number) => {
			assignedScroll = v;
		},
		getPoolScroll: () => poolScroll,
		setPoolScroll: (v: number) => {
			poolScroll = v;
		},
		selectedProvider,
		moveCursor,
		onTab,
		onActivate,
		onDelete,
		ensureVisible,
		finish,
		apiCompatible,
		poolGrouper: (ids: string[]) => groupPoolByOwnedBy(ids, catalog),
		assignedIdsFor: (p: ProviderEntry) => assignedIdsFor(cfg, p),
		poolFor: (p: ProviderEntry) => poolFor(cfg, p, catalog),
	});
}

// The component assembly (render + input) lives next-door to keep this file
// readable. We import it lazily to dodge circular imports.
import { assembleComponent } from "./picker-component.ts";
// Re-export helpers used by the component file (avoid duplicate imports).
export {
	pad,
	renderEmpty,
	renderModelRow,
	renderNewProviderRow,
	renderPanelHeader,
	renderProviderRow,
	renderSubheader,
	visibleWidth,
};
export type { RightRow };
export { matchesKey, getKeybindings };
