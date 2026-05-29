// Slash commands.
//   /cliproxy           — open the picker overlay
//   /cliproxy-setup     — first-run / re-run setup wizard for endpoint+keys
//   /cliproxy-refresh   — refetch discovery + re-apply
//   /cliproxy-usage     — fetch /api/usage and render in overlay
//   /cliproxy-doctor    — connectivity + key-resolution diagnostics

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { applyAll } from "./apply.ts";
import { loadConfig, resolveConfigValue, saveConfig } from "./config.ts";
import { detectConflicts } from "./conflicts.ts";
import { fetchDiscovery, PLUGIN_USER_AGENT } from "./fetch-models.ts";
import { clearUsageCache, fetchUsage } from "./fetch-usage.ts";
import { log } from "./log.ts";
import { showOverlay } from "./ui-overlay.ts";
import { runPicker } from "./ui-picker/index.ts";
import { runSetup } from "./ui-setup.ts";
import { renderUsage } from "./ui-usage.ts";

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("cliproxy", {
		description:
			"Pick which models to expose via the CliProxyAPI corporate proxy",
		handler: handleCliproxy.bind(null, pi),
	});

	pi.registerCommand("cliproxy-setup", {
		description:
			"Set endpoint, API key, and (optional) usage key for the proxy",
		handler: handleSetup.bind(null, pi),
	});

	pi.registerCommand("cliproxy-refresh", {
		description:
			"Re-fetch upstream model list and re-apply provider registrations",
		handler: handleRefresh.bind(null, pi),
	});

	pi.registerCommand("cliproxy-usage", {
		description: "Show per-account quota windows from the upstream",
		handler: handleUsage,
	});

	pi.registerCommand("cliproxy-doctor", {
		description: "Check connectivity, key resolution, and discovery shape",
		handler: handleDoctor,
	});
}

// --------------------------------------------------------------------------- /cliproxy

async function handleCliproxy(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cfg = loadConfig();
	if (!cfg.proxy.endpoint || !resolveConfigValue(cfg.proxy.apiKey)) {
		ctx.ui.notify(
			"endpoint or API key not set \u2014 launching /cliproxy-setup first",
			"info",
		);
		const ok = await runSetup(ctx, true);
		if (!ok) return;
	}
	const current = loadConfig();
	const resolvedKey = resolveConfigValue(current.proxy.apiKey);
	let discovery;
	try {
		discovery = await fetchDiscovery(current, resolvedKey);
	} catch (err) {
		ctx.ui.notify(`discovery failed: ${(err as Error).message}`, "error");
		return;
	}
	const updated = await runPicker(ctx, current, discovery);
	if (!updated) {
		ctx.ui.notify("changes discarded", "info");
		return;
	}
	saveConfig(updated);
	const rep = await applyAll(pi, updated, discovery);
	ctx.ui.notify(
		`saved \u00b7 ${rep.registered.length} providers registered, ${rep.skipped.length} skipped`,
		"info",
	);
}

// --------------------------------------------------------------------------- /cliproxy-setup

async function handleSetup(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const ok = await runSetup(ctx, true);
	if (!ok) return;
	// After saving, eagerly reapply so the new endpoint/key actually takes effect.
	const cfg = loadConfig();
	try {
		const discovery = await fetchDiscovery(
			cfg,
			resolveConfigValue(cfg.proxy.apiKey),
		);
		const rep = await applyAll(pi, cfg, discovery);
		clearUsageCache();
		ctx.ui.notify(
			`setup ok \u00b7 ${rep.registered.length} providers registered (source=${discovery.source})`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`setup saved, but apply failed: ${(err as Error).message}`,
			"warning",
		);
	}
}

// --------------------------------------------------------------------------- /cliproxy-refresh

async function handleRefresh(
	pi: ExtensionAPI,
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cfg = loadConfig();
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	try {
		const discovery = await fetchDiscovery(cfg, resolvedKey);
		const rep = await applyAll(pi, cfg, discovery);
		clearUsageCache();
		ctx.ui.notify(
			`cliproxy: ${rep.registered.length} providers registered, ${rep.skipped.length} skipped (source=${discovery.source})`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(`refresh failed: ${(err as Error).message}`, "error");
	}
}

// --------------------------------------------------------------------------- /cliproxy-usage

async function handleUsage(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const force = /(^|\s)--refresh(\s|$)/.test(args);
	const cfg = loadConfig();
	const usageKey = resolveConfigValue(cfg.proxy.usageKey);
	let doc;
	try {
		doc = await fetchUsage(cfg, usageKey, { force });
	} catch (err) {
		ctx.ui.notify(`usage failed: ${(err as Error).message}`, "error");
		return;
	}
	await showOverlay(ctx, "cliproxy-usage", {
		render: (state) =>
			renderUsage(doc, {
				showDisabled: state["d"] === true,
				verbose: state["v"] === true,
			}).join("\n"),
		toggles: [
			{ key: "d", hint: "d disabled" },
			{ key: "v", hint: "v verbose" },
		],
	});
}

// --------------------------------------------------------------------------- /cliproxy-doctor

async function handleDoctor(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const cfg = loadConfig();
	const lines: string[] = [];
	lines.push(`endpoint: ${cfg.proxy.endpoint}`);
	lines.push(
		`apiKey resolves: ${resolveConfigValue(cfg.proxy.apiKey) ? "yes" : "NO (empty after resolution)"}`,
	);
	lines.push(
		`usageKey resolves: ${cfg.proxy.usageKey ? (resolveConfigValue(cfg.proxy.usageKey) ? "yes" : "NO") : "not configured"}`,
	);
	lines.push(`user-agent: ${PLUGIN_USER_AGENT}`);

	try {
		const discovery = await fetchDiscovery(
			cfg,
			resolveConfigValue(cfg.proxy.apiKey),
		);
		lines.push("");
		lines.push(`discovery source: ${discovery.source}`);
		lines.push(`upstream version: ${discovery.upstreamVersion ?? "(unknown)"}`);
		lines.push(`upstream total ids: ${discovery.upstreamTotal}`);
		lines.push(
			`built-in providers seen: ${discovery.builtinProviders.map((p) => `${p.name}=${p.models.length}`).join(", ") || "(none)"}`,
		);
		lines.push(`custom pool size: ${discovery.customPool.length}`);
	} catch (err) {
		lines.push("");
		lines.push(`discovery FAILED: ${(err as Error).message}`);
	}

	const conflicts = detectConflicts(cfg);
	if (conflicts.length > 0) {
		lines.push("");
		lines.push("conflicts:");
		for (const c of conflicts) lines.push(`  [${c.kind}] ${c.detail}`);
	} else {
		lines.push("");
		lines.push("conflicts: none");
	}

	log.info("doctor:", lines.join(" | "));
	await showOverlay(ctx, "cliproxy-doctor", lines.join("\n"));
}
