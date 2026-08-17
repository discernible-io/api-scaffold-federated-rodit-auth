# Configuration Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Internal conventions for how this peer loads, prioritizes, validates, and **surfaces configuration in logs** safely. Audience: contributors and operators, not API consumers.

**Reference**

- Host app: [`src/app.js`](../src/app.js) — `const { config } = require("@rodit/rodit-auth-be")` and `config.get(...)`
- SDK resolution: `@rodit/rodit-auth-be`
- Checked-in files: [`config/default.json`](../config/default.json), [`config/custom-environment-variables.json`](../config/custom-environment-variables.json)
- Permission map: [`scripts/update-permissionsmap.js`](../scripts/update-permissionsmap.js)

**Related:** [`logging-standard.md`](logging-standard.md), [`cicd-deployment-standard.md`](cicd-deployment-standard.md) (host `secrets/secrets.env` and TLS).

---

## Configuration sources

| Source | Role |
| --- | --- |
| **Secrets from host (`secrets/secrets.env`)** | Runtime secrets (API keys, credentials, tokens) injected via `custom-environment-variables.json`. Never committed. |
| **`config/default.json`** | Non-secret settings for this peer (`SERVICE_NAME`, ports, `LOG_LEVEL`, `METHOD_PERMISSION_MAP`). |
| **Environment variables** | Override via names in `config/custom-environment-variables.json`. |
| **SDK `FALLBACK_DEFAULTS`** | Baked-in defaults from `@rodit/rodit-auth-be` when the host defines no value. |

---

## Priority order (effective value per key)

Resolution is in the SDK `get(pathStr, defaultValue)`:

1. **`process.env`** — path becomes uppercase with dots as underscores (`SECURITY_OPTIONS.LOGIN_MODE` → `SECURITY_OPTIONS_LOGIN_MODE`).
2. **Host `node-config`** — [`config/default.json`](../config/default.json) plus env mapping from [`config/custom-environment-variables.json`](../config/custom-environment-variables.json).
3. **SDK `FALLBACK_DEFAULTS`**
4. **Optional `defaultValue` argument to `config.get`**

### Boolean encoding

Only string values: `"true"` and `"false"`. Do not use JSON literals `true`/`false` or `1`/`0`.

### Fallback semantics

For runtime path selection (auth, routing, signing), use nullish fallback (`??`) rather than truthy fallback (`||`) unless truthy behavior is documented.

**Application rule:** Import configuration through `@rodit/rodit-auth-be` (`config.get`). Avoid ad-hoc `process.env` in application code.

---

## Managing configuration

| File | Contents |
| --- | --- |
| [`config/default.json`](../config/default.json) | Full non-secret config, including `METHOD_PERMISSION_MAP` |
| [`config/custom-environment-variables.json`](../config/custom-environment-variables.json) | Env var → config mapping |
| `secrets/secrets.env` (host, not in git) | `NEAR_RPC_URL`, `LOKI_BASIC_AUTH`, `SESSION_SECRET`, NEAR/Vault credentials |

Typical host secrets: `LOKI_BASIC_AUTH`, `NEAR_CREDENTIALS_JSON_B64`, `NEAR_RPC_URL`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`, `SECURITY_OPTIONS_SESSION_SECRET`.

Set `SERVICE_NAME` in `config/default.json` (and nginx `server_name` / OpenAPI `servers`) to **this peer’s** hostname.

Committed JSON may include the placeholder `HMAC-session-secret-is-not-set` for `SECURITY_OPTIONS.SESSION_SECRET`. Override it on the host via `secrets.env`.

### Generated `METHOD_PERMISSION_MAP`

Generated from [`api-docs/swagger.json`](../api-docs/swagger.json) into `config/default.json`.

```bash
npm run update:permissions
npm run validate:permissions
```

The generator uses the **last path segment** of each authenticated swagger path. Unauthenticated routes are omitted.

---

## Validation

Before the HTTP server listens, startup calls **`validateConfig(logger)`**. Failures abort startup and are logged with structured context (key names, not secret values).

---

## Visualization via logs

- **Validation** — pass/fail before listen; no raw secrets.
- **Server listen** — port and endpoints in [`src/app.js`](../src/app.js).
- **`GET /health`** — `{ status, timestamp }` only.
- **Resolved snapshot** — redacted map after listen (`PRESENT-REDACTED` / `ABSENT` for sensitive keys) from [`src/services/startup-config.service.js`](../src/services/startup-config.service.js).

---

## Review checklist

- New tunable behavior uses `config.get`, not ad-hoc `process.env` in route code.
- Runtime path selection uses `??` unless a documented reason requires `||`.
- Secrets stay in host `secrets.env` / env mapping.
- After swagger auth changes, run `npm run update:permissions` and commit `config/default.json`.
