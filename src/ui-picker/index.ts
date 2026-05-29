// Public entry for the /cliproxy three-panel picker.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ProxyConfig } from "../config.ts";
import type { Discovery } from "../fetch-models.ts";
import { buildPicker } from "./picker.ts";
import type { OverlayTui, Theme } from "./types.ts";

export async function runPicker(
	ctx: ExtensionCommandContext,
	cfg: ProxyConfig,
	discovery: Discovery,
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
				done,
			),
		{
			overlay: true,
			overlayOptions: { width: 170, maxHeight: "94%" },
		},
	);
}
