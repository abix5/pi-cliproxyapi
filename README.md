# pi-cliproxyapi

Pi extension for **corporate management** of model providers via a single CliProxyAPI endpoint.

## What it does

Owns one pair of `(endpoint, apiKey)` for the corporate proxy. Discovers
the full upstream model list, then lets you:

- Route Pi built-in providers (Anthropic, OpenAI, …) through the proxy with a
  per-model whitelist.
- Create custom provider groups for proxy-only models (GLM, Gemini via
  Antigravity, Ollama, etc.) with a configurable prefix.
- View per-account quota windows and subscription limits without making any
  LLM call.

## Commands

| Command | Description |
| --- | --- |
| `/cliproxy` | Interactive overlay picker — enable providers, toggle models, create custom groups. |
| `/cliproxy-setup` | Wizard: endpoint, API key, provider prefix, (optional) usage key. |
| `/cliproxy-refresh` | Re-fetch upstream models and re-register all providers. |
| `/cliproxy-list` | Read-only overlay — same view as `/cliproxy` but no editing. |
| `/cliproxy-usage` | Per-account quota windows with colored progress bars. Toggles: `d` disabled, `v` verbose. |
| `/cliproxy-doctor` | Connectivity, key resolution, discovery diagnostics, conflict scan. |

## Config

`~/.config/pi-cliproxyapi/config.json` — created by `/cliproxy-setup`, editable by hand.

```jsonc
{
  "proxy": {
    "endpoint": "https://your-proxy.example.com/v1",
    "apiKey": "!cat ~/.config/pi-cliproxyapi/key",
    "providerPrefix": "myproxy",
    "usageKey": "!cat ~/.config/pi-cliproxyapi/usage-key"
  },
  "builtinProviders": { ... },
  "customProviders": { ... },
  "discoveryExcludes": ["*:*"],
  "overrides": {},
  "refreshIntervalMinutes": 0,
  "usageCacheTtlMs": 30000
}
```

Values support `!command` (shell exec), `$ENV_VAR`, `~/path` (auto-wrapped to `!cat`), or literal strings.

## Install

```bash
pi install ./path/to/pi-cliproxyapi
```

Then `/cliproxy-setup` to configure, `/cliproxy` to pick models.
