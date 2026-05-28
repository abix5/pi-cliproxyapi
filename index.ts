/**
 * pi-cliproxyapi — Pi extension that manages model providers through a single
 * CliProxyAPI endpoint with one corporate key.
 *
 * On factory boot we:
 *   1. load ~/.config/pi-cliproxyapi/config.json (defaults if missing)
 *   2. fetch discovery (well-known → fall back to /v1/models)
 *   3. call pi.registerProvider for each enabled built-in + custom provider
 *   4. register slash commands /cliproxy /cliproxy-setup /cliproxy-refresh
 *      /cliproxy-list /cliproxy-usage /cliproxy-doctor
 *
 * All discovery + apply errors are logged but never abort extension load —
 * a missing/broken proxy must not prevent Pi from starting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { applyAll } from "./src/apply.ts";
import { registerCommands } from "./src/commands.ts";
import { loadConfig, resolveConfigValue } from "./src/config.ts";
import { detectConflicts } from "./src/conflicts.ts";
import { fetchDiscovery } from "./src/fetch-models.ts";
import { log } from "./src/log.ts";

export default async function cliproxyapi(pi: ExtensionAPI): Promise<void> {
	registerCommands(pi);

	const cfg = loadConfig();
	const resolvedKey = resolveConfigValue(cfg.proxy.apiKey);
	if (!resolvedKey) {
		log.warn(
			"apiKey is empty after resolution — skipping initial apply. Run /cliproxy-setup to configure.",
		);
		return;
	}

	// Conflict scan is read-only and cheap; do it once at startup.
	const conflicts = detectConflicts(cfg);
	for (const c of conflicts) log.warn(`conflict (${c.kind}): ${c.detail}`);

	try {
		const discovery = await fetchDiscovery(cfg, resolvedKey);
		await applyAll(pi, cfg, discovery);
	} catch (err) {
		log.error("initial apply failed:", (err as Error).message);
		// Commands stay registered; user can /cliproxy-doctor or /cliproxy-refresh.
	}

	if (cfg.refreshIntervalMinutes > 0) {
		const ms = cfg.refreshIntervalMinutes * 60_000;
		setInterval(() => {
			void (async () => {
				try {
					const c = loadConfig();
					const k = resolveConfigValue(c.proxy.apiKey);
					if (!k) return;
					const d = await fetchDiscovery(c, k);
					await applyAll(pi, c, d);
					log.debug("background refresh ok");
				} catch (e) {
					log.warn("background refresh failed:", (e as Error).message);
				}
			})();
		}, ms);
		log.info(`background refresh every ${cfg.refreshIntervalMinutes}m`);
	}
}
