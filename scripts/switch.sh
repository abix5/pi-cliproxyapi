#!/usr/bin/env bash
# ~/Projects/pi-lproxy/scripts/switch.sh
# Toggle the pi extension between local dev (this repo) and npm prod.
# Usage:
#   ./scripts/switch.sh dev    -> use ~/Projects/pi-lproxy (live edits)
#   ./scripts/switch.sh prod   -> use npm:pi-cliproxyapi
#   ./scripts/switch.sh status -> show which one is active

set -euo pipefail
mode="${1:-status}"
SETTINGS="$HOME/.pi/agent/settings.json"
DEV_PATH="../../Projects/pi-lproxy"
PROD_PATH="npm:pi-cliproxyapi"

has() { jq -e --arg v "$1" '.packages | index($v)' "$SETTINGS" >/dev/null 2>&1; }

case "$mode" in
status)
	if has "$DEV_PATH"; then echo "dev (local: $DEV_PATH)"; fi
	if has "$PROD_PATH"; then echo "prod ($PROD_PATH)"; fi
	;;
dev)
	pi remove "$PROD_PATH" 2>/dev/null || true
	has "$DEV_PATH" || pi install "$HOME/Projects/pi-lproxy"
	echo "switched to dev. start a new pi session to load it."
	;;
prod)
	pi remove "$DEV_PATH" 2>/dev/null || true
	has "$PROD_PATH" || pi install "$PROD_PATH"
	echo "switched to prod. start a new pi session to load it."
	;;
*)
	echo "usage: $0 {dev|prod|status}" >&2
	exit 2
	;;
esac
