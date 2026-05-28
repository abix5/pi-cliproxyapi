// Tiny logger that prefixes all messages with the extension tag.
// Uses console.* directly — pi pipes stdout/stderr into its log sink.

const TAG = "[pi-cliproxyapi]";

export const log = {
	info(...args: unknown[]): void {
		console.log(TAG, ...args);
	},
	warn(...args: unknown[]): void {
		console.warn(TAG, ...args);
	},
	error(...args: unknown[]): void {
		console.error(TAG, ...args);
	},
	debug(...args: unknown[]): void {
		if (process.env.PI_CLIPROXYAPI_DEBUG) console.log(TAG, "[debug]", ...args);
	},
};
