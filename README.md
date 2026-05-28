# pi-cliproxyapi

Pi extension for corporate management of model providers via a single [CliProxyAPI](https://github.com/nicepkg/cliproxyapi) endpoint.

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

## Install

```bash
pi install pi-cliproxyapi
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

The plugin tries `GET <endpoint-origin>/.well-known/pi` first (requires the companion sidecar service). If unavailable, falls back to `GET <endpoint>/models` with local heuristics.

### Optional: companion discovery service

For richer model metadata (context windows, costs, reasoning flags from models.dev) and per-account usage, deploy **[pi-cliproxyapi-wellknown](https://github.com/abix5/pi-cliproxyapi-wellknown)** alongside your CliProxyAPI instance.

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

The sidecar is **optional** — the plugin works without it using `/v1/models` + local classification.

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
