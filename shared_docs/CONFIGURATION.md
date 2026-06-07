# Configuration

This document is the single reference for how WorkPilot AI loads its runtime
configuration. It covers:

1. The LLM provider registry (`configured_providers.json`).
2. The per-user provider configurations (`~/.work_pilot_ai_llm_providers.json`).
3. The authentication token resolution order.

---

## 1. LLM provider registry — `configured_providers.json`

**Location:** [config/configured_providers.json](../config/configured_providers.json).
**Format:** JSON.
**Source of truth for:** both the **backend** (Python) and the
**frontend** (TypeScript).

Consumers:

- **Backend Python** — [core/configured_providers.py](../apps/backend/core/configured_providers.py)
  (typed loader with validation) and [provider_api.py](../apps/backend/provider_api.py#L1).
  Validated against `ConfiguredProvider` at load time — malformed entries
  raise immediately instead of silently propagating empty strings.
- **Frontend TypeScript** — a typed module is **generated** from the JSON
  at [apps/frontend/src/shared/types/providers.generated.ts](../apps/frontend/src/shared/types/providers.generated.ts).
  It exposes `ConfiguredProvider`, `ProviderName` (union of every known
  ID), `CONFIGURED_PROVIDERS`, and `isProviderName()` as a type guard.

**Regenerate after editing the JSON:**

```bash
pnpm run generate:provider-types
```

**CI check** — fails if the generated file drifts from the JSON:

```bash
pnpm run validate:provider-types
```

The file must not be duplicated. A previous copy at
`utils/config/configured_providers.json` has been removed; any reference
to that path is stale and should point at `config/`.

### Shape

```json
{
  "providers": [
    {
      "id": "anthropic",
      "label": "Anthropic (Claude)",
      "models": ["claude-3-5-sonnet-20241022", "claude-opus-4-7"],
      "default_model": "claude-opus-4-7",
      "capabilities": ["chat", "tools", "streaming"]
    }
  ]
}
```

If you add a new provider field, update both consumers in the same PR:
- backend: `apps/backend/provider_api.py`
- frontend: `apps/frontend/src/renderer/services/providers.*` (or equivalent)

---

## 2. Per-user provider config — `~/.work_pilot_ai_llm_providers.json`

**Location:** user home directory.
**Owner:** [src/connectors/llm_config.py](../src/connectors/llm_config.py).

Stores user-specific provider settings (API keys, base URLs, model
overrides) and the currently **active** provider. Managed from the CLI:

```bash
# List providers (the active one is marked "(actif)")
python -m apps.backend.cli provider list

# Select the active provider (persisted)
python -m apps.backend.cli provider select --provider openai

# Save a provider configuration
python -m apps.backend.cli provider add \
    --provider openai \
    --config '{"api_key":"sk-...","model":"gpt-4o"}'

# Test a provider
python -m apps.backend.cli provider test --provider openai

# Delete a provider's saved config
python -m apps.backend.cli provider delete --provider openai
```

Internally, the active provider is stored under the reserved key
`__active_provider__`. That key is filtered out of `list_provider_configs()`,
so it never appears as a "configured provider" in the UI.

---

## 3. Authentication token resolution order

Implemented in [apps/backend/core/auth.py](../apps/backend/core/auth.py)
(`get_auth_token`). The first source that yields a token wins.

| # | Source | Notes |
|---|--------|-------|
| 1 | `CLAUDE_CODE_OAUTH_TOKEN` env var | OAuth token from Claude Code CLI. |
| 2 | `ANTHROPIC_AUTH_TOKEN` env var | For CCR / proxy / enterprise setups. |
| 3 | `config_dir` argument | Explicitly passed by the caller. |
| 4 | `CLAUDE_CONFIG_DIR` env var | Profile-specific config directory. |
| 5 | `.credentials.json` in (3) or (4) | File-based storage. |
| 6 | System credential store | macOS Keychain, Windows Credential Manager, Linux Secret Service (via `secretstorage`). |

### Deliberately **not** supported

- **`ANTHROPIC_API_KEY`** is intentionally excluded. Supporting it could
  silently bill the user's API credits if the OAuth path misconfigures —
  a failure mode we've explicitly ruled out.

### Linux-specific requirement

On Linux, reading from the system credential store requires the optional
`secretstorage` package. If it is not installed, the backend logs a
**warning at startup** and the keychain path is skipped — tokens will only
be resolved from env vars or the credentials file.

```bash
pip install secretstorage
```

### Encrypted tokens

Tokens prefixed with `enc:` are Claude Code CLI-encrypted. They are
auto-decrypted via `_try_decrypt_token`. If decryption fails, the backend
raises a clear error pointing the user at `claude setup-token`.

---

## Mock / stub behaviors to be aware of

A few connectors currently fall back to deterministic stubs when their
real integration is not configured. They **log a warning** when this path
is taken so the user knows the output is not live data:

- **Bounty board** — contestants fall back to a `[stub:...]` output string
  when the `llm_client` module is not importable. Logs a warning per
  contestant.
- **Analytics API** ([apps/backend/analytics/api_minimal.py](../apps/backend/analytics/api_minimal.py))
  currently returns empty/mock payloads for every endpoint. Treat it as a
  scaffold until a real database-backed implementation lands.
