# pi-cliproxyapi

[![npm](https://img.shields.io/npm/v/pi-cliproxyapi)](https://www.npmjs.com/package/pi-cliproxyapi)
[![GitHub](https://img.shields.io/github/license/abix5/pi-cliproxyapi)](https://github.com/abix5/pi-cliproxyapi)

Pi extension for corporate management of model providers via a single [CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) endpoint.

One `(endpoint, apiKey)` pair — every provider and model inherits it automatically.

## Features

- **Built-in provider routing** — whitelist which Anthropic / OpenAI / etc. models are available through the proxy
- **Custom provider groups** — create named groups (e.g. `corp-glm`, `corp-gemini`) for proxy-only models with automatic metadata from [models.dev](https://models.dev)
- **Exclusive model pool** — a model assigned to one group automatically disappears from others
- **Per-account usage overlay** — colored quota bars, toggle disabled accounts, verbose errors — no LLM call
- **Setup wizard** — `/cliproxy-setup` configures endpoint, API key, provider prefix, and usage key interactively

## Commands

| Command | Description |
| --- | --- |
| `/cliproxy` | Interactive overlay — enable providers, toggle models, create custom groups |
| `/cliproxy-setup` | Configure endpoint, API key, provider prefix, usage key |
| `/cliproxy-refresh` | Re-fetch upstream models, re-register providers |
| `/cliproxy-list` | Read-only view of current configuration |
| `/cliproxy-usage` | Per-account quota windows with progress bars (`d` = show disabled, `v` = verbose) |
| `/cliproxy-doctor` | Connectivity, key resolution, discovery diagnostics |

## Prerequisites

You need a running [CliProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance — this is the corporate LLM proxy that aggregates multiple providers behind a single OpenAI-compatible endpoint.

For full functionality (`/cliproxy-usage`, enriched model metadata from [models.dev](https://models.dev)), also deploy the companion sidecar: **[pi-cliproxyapi-wellknown](https://github.com/abix5/pi-cliproxyapi-wellknown)**. See [Deploying the sidecar](#deploying-the-sidecar-service) below.

## Install

```bash
pi install npm:pi-cliproxyapi
```

Then run `/cliproxy-setup` to configure your proxy endpoint.

## Config

`~/.config/pi-cliproxyapi/config.json` — created by `/cliproxy-setup`, editable by hand:

```jsonc
{
  "proxy": {
    "endpoint": "https://proxy.example.com/v1",
    "apiKey": "!cat ~/.config/pi-cliproxyapi/key",
    "providerPrefix": "corp",
    "usageKey": "!cat ~/.config/pi-cliproxyapi/usage-key"
  },
  "builtinProviders": {
    "anthropic": { "enabled": true, "models": ["claude-opus-4-7"] },
    "openai": { "enabled": true, "models": ["gpt-5.2"] }
  },
  "customProviders": {
    "corp-glm": {
      "api": "openai-completions",
      "models": [{ "id": "glm-4.7", "name": "GLM 4.7" }]
    }
  }
}
```

Values support `!command` (shell exec), `$ENV_VAR`, `~/path` (auto-wrapped to `!cat`), or literal strings.

## Discovery

The plugin tries `GET <endpoint-origin>/.well-known/pi` first (requires the sidecar). If unavailable, falls back to `GET <endpoint>/models` with local heuristics.

## Deploying the sidecar service

The **[pi-cliproxyapi-wellknown](https://github.com/abix5/pi-cliproxyapi-wellknown)** sidecar runs alongside CliProxyAPI and provides:

- `/.well-known/pi` — model discovery with metadata from [models.dev](https://models.dev) (context windows, costs, reasoning flags)
- `/api/usage` — per-account quota windows used by `/cliproxy-usage`

```
┌──────────────┐     ┌───────────────────────────┐
│  Pi + plugin  │────▶│  CliProxyAPI (:8317)       │
│               │     │  /v1/models, /v1/chat/...  │
│               │     └───────────────────────────┘
│               │     ┌───────────────────────────┐
│               │────▶│  wellknown sidecar (:3458)  │
│               │     │  /.well-known/pi            │
│               │     │  /api/usage                 │
│               │     └───────────────────────────┘
└──────────────┘
```

### Quick start with Docker Compose

Clone the sidecar repo next to your CliProxyAPI deployment:

```bash
git clone https://github.com/abix5/pi-cliproxyapi-wellknown.git
```

Add to your `docker-compose.yml`:

```yaml
services:
  cliproxyapi:
    # ... your existing CliProxyAPI service ...

  pi-cliproxyapi-wellknown:
    build:
      context: ./pi-cliproxyapi-wellknown
    restart: unless-stopped
    ports:
      - "127.0.0.1:3458:3458"
    environment:
      UPSTREAM_MODELS_URL: http://cliproxyapi:8317/v1/models
      UPSTREAM_TOKEN: ${UPSTREAM_TOKEN}          # CliProxyAPI bearer key
      PI_PUBLIC_BASE_URL: ${PI_PUBLIC_BASE_URL}  # e.g. https://proxy.example.com/v1
      MANAGEMENT_API_URL: http://cliproxyapi:8317/v0/management
      MANAGEMENT_API_KEY: ${MANAGEMENT_API_KEY}
      PI_PLUGIN_USAGE_KEY: ${PI_PLUGIN_USAGE_KEY}  # shared with Pi plugin
    depends_on:
      cliproxyapi:
        condition: service_healthy
    networks:
      - your-network
```

Then route `/.well-known/pi` and `/api/usage` on your public domain to port 3458 via your reverse proxy (Nginx, Caddy, Cloudflare Tunnel, etc.).

### Connecting the plugin

Run `/cliproxy-setup` in Pi and enter:
- **endpoint** — your public proxy URL ending with `/v1`
- **apiKey** — CliProxyAPI bearer key
- **providerPrefix** — short slug for custom provider names (e.g. `corp`, `myproxy`)
- **usageKey** — same value as `PI_PLUGIN_USAGE_KEY` above (enables `/cliproxy-usage`)

The sidecar is **optional** — the plugin works without it using `/v1/models` + local classification. But you lose enriched metadata and `/cliproxy-usage`.

## Layout

```
index.ts            ExtensionFactory entry point
src/
  config.ts         ~/.config/pi-cliproxyapi/config.json
  commands.ts       6 slash commands
  apply.ts          pi.registerProvider calls
  fetch-models.ts   well-known + /v1/models fallback
  fetch-usage.ts    /api/usage client with TTL cache
  compat.ts         baseUrl derivation, model classification
  conflicts.ts      read-only ~/.pi/{models,auth}.json scan
  ui-picker.ts      overlay picker with collapsible provider groups
  ui-usage.ts       ANSI-colored usage renderer
  ui-overlay.ts     scrollable overlay shell with toggles
  ui-setup.ts       setup wizard
  log.ts            tagged logger
```
