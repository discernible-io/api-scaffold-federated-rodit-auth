# Configuration Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Internal conventions for how a service loads, prioritizes, validates, and **surfaces configuration in logs** safely. Audience: contributors and operators, not API consumers.

> **How to read this document:** Generic patterns are described first. Concrete values are labelled *Example (…)* or shown as service-relative paths. In **discernible-io/docs**, those paths resolve in the **consuming service repository** (see [`documentation-standard.md`](documentation-standard.md#service-relative-links)).

**Reference implementations** *(consuming service — service-relative paths)*

- Host app: [`src/app.js`](../src/app.js) — `const { config } = require("@rodit/rodit-auth-be")` and `config.get(...)` for `SERVERPORT`, `SERVICE_NAME`, `ENABLE_SIGNROOT`, etc.
- SDK resolution logic: `@rodit/rodit-auth-be` (package; not vendored in this repository)
- Checked-in env files: [`config/development.json`](../config/development.json), [`config/main.json`](../config/main.json), [`config/custom-environment-variables.json`](../config/custom-environment-variables.json)
- Permission map generator: [`scripts/update-permissionsmap.js`](../scripts/update-permissionsmap.js)
- Winston/Loki bootstrap: [`src/app.js`](../src/app.js) (top-level IIFE; `LOG_LEVEL`, `LOKI_URL`, and related keys via `config.get`)

**Related docs:** [`logging-standard.md`](logging-standard.md) — effective `LOG_LEVEL` filtering, transports, and how environment ties to verbosity. [`cicd-deployment-standard.md`](cicd-deployment-standard.md) — how to create host `secrets/secrets.env` and TLS material before CI deploys.

---

## Configuration sources

| Source | Role |
| --- | --- |
| **Secrets from host (`secrets/secrets.env`)** | Runtime secrets (API keys, credentials, tokens) injected via `custom-environment-variables.json` mapping. Never committed to repo. |
| **Environment-specific config files** | `config/{NODE_ENV}.json` (e.g., `config/development.json`, `config/main.json`) for branch-specific non-secret settings. Prevents accidental overwrites when merging branches. File names match the value of `NODE_ENV` set by the deployment workflow. |
| **Environment variables** | Primary override in deployments and CI (mapped via `custom-environment-variables.json`). |
| **SDK `FALLBACK_DEFAULTS`** | Baked-in defaults shipped with `@rodit/rodit-auth-be` when the host defines no value. |

Enrollment and product copy are **not** part of tunable deployment config—they live under [`src/config/`](../src/config/) (how-to MCP content), separate from [`config/`](../config/) at the repo root.

---

## Priority order (effective value per key)

Resolution is implemented in `configsdk.js` → `get(pathStr, defaultValue)`. For a given key path (for example `NEAR_RPC_URL` or `SECURITY_OPTIONS.LOGIN_MODE`):

1. **`process.env` under the SDK naming convention**  
   The key path is turned into an environment variable name: uppercase, dot segments become underscores (for example `SECURITY_OPTIONS.LOGIN_MODE` → `SECURITY_OPTIONS_LOGIN_MODE`). If that variable is set, its value is parsed against the expected type for that key.

### Boolean encoding rule (uniform)

For boolean configuration values across all configuration sources (environment variables and `config/*.json`), only string values are supported:

- `"true"`
- `"false"`

Do not use JSON boolean literals (`true`/`false`) and do not use numeric/binary encodings such as `1`/`0`. Malformed boolean values are treated as invalid and the resolver falls back to SDK defaults when available.

2. **Host `node-config`**  
   Values from `config/{NODE_ENV}.json` (and optional `config/default.json` if present) after the `config` package merge rules, including overrides driven by `config/custom-environment-variables.json`.

3. **SDK `FALLBACK_DEFAULTS`**  
   Used only when no value is available from (1) or (2).

4. **Optional `defaultValue` argument to `config.get`**  
   Used only if the key is still undefined. *This repo* does not rely on that path for normal keys; each `config/<NODE_ENV>.json` is a **complete** file for its branch image.

### Fallback semantics for execution paths

When selecting behavior that changes runtime execution paths (for example auth identity source, route paths, or signing inputs), use **nullish fallback** (`??`) rather than truthy fallback (`||`) unless truthy behavior is explicitly required and documented.

- `??` falls back only on `undefined` or `null`.
- `||` falls back on any falsy value (`""`, `0`, `false`, `NaN`), which can silently override intentional configuration.

Use `||` primarily for presentation/logging defaults where truthy coercion is acceptable.

### Edge-case note: env fallback in SDK utils

In `sdk/utils.js`, the compatibility fallback uses `process.env[key] || null`. This means an empty string is treated as missing. Keep this behavior explicit in code comments and avoid relying on empty-string values in that fallback path.

**Application rule:** Import configuration through `@rodit/rodit-auth-be` (`config.get`). Avoid ad-hoc `process.env` in application code so priority stays consistent (including the Loki bootstrap IIFE in `src/app.js`).

---

## Managing configuration

### Configuration files

- **`config/<NODE_ENV>.json`** — Non-secret configuration for each branch. Committed to the corresponding branch. The file name matches the `NODE_ENV` value the workflow sets for that branch.
  - *This repo:* `config/development.json` (NODE_ENV: `"development"`, `development` branch) and `config/main.json` (NODE_ENV: `"main"`, `main` branch). Each file is **self-contained**; there is no shared application settings layer in git (do not add tunable keys to a hypothetical `config/default.json`).
- **`config/custom-environment-variables.json`** — Maps secrets from host `secrets/secrets.env` to config keys. Allows runtime override of secrets via environment variables.

*This repo — host `config/` layout:*

| File | When loaded | Contents |
| --- | --- | --- |
| [`config/development.json`](../config/development.json) | `NODE_ENV=development` | Full config for `slc.dihola.io` / `development` branch |
| [`config/main.json`](../config/main.json) | `NODE_ENV=main` | Full config for `slc.discernible.io` / `main` branch |
| [`config/custom-environment-variables.json`](../config/custom-environment-variables.json) | Runtime | Env var → config mapping |
| `secrets/secrets.env` (host, not in git) | Runtime | `NEAR_RPC_URL`, `LOKI_BASIC_AUTH`, production `SESSION_SECRET`, etc. |

`NODE_ENV` is set by CI or the container (`development` or `main`), not inside the JSON files.

### Secrets and environment variables

- **`secrets/secrets.env`** (host-only, never committed) — Contains only runtime secrets. Each service defines its own set.
  - *This repo:* `LOKI_BASIC_AUTH`, `NEAR_CREDENTIALS_JSON_B64`, `NEAR_RPC_URL`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`.
- **Env → config mapping** is declared in [`config/custom-environment-variables.json`](../config/custom-environment-variables.json). When adding a new secret, update that file so operators can set it via a stable env name.
- **Secrets** (tokens, basic auth, private keys) must not appear in logs. They may be present in environment or vault-backed stores per your deployment; the runtime snapshot **redacts** sensitive key paths (see below).

### Branch-specific deployment

- **`development` branch** → uses `config/development.json` → deploys to development server
- **`main` branch** → uses `config/main.json` → deploys to main server
- Merging `development` → `main` never overwrites main configuration

### Environment-specific configuration requirements

Certain config keys **must differ** between development and main branches. These are keys whose value is tied to a specific deployment target — using the wrong value will cause failures in the target environment.

- Each branch's `config/<NODE_ENV>.json` must contain the environment-appropriate value for these keys.
- **Do not synchronize these values across branches.** Each branch maintains its own value appropriate to its deployment target.
- All other keys are duplicated in both files so each branch image is self-contained.

*This repo — keys that must differ (authoritative values are in the JSON files; table for quick reference):*

| Key | `development` | `main` |
| --- | --- | --- |
| `SERVICE_NAME` | `slc.dihola.io` | `slc.discernible.io` |
| `SIGNPORTAL_API_URL` | signportal.dihola.io | signportal.roditcorp.com |
| `NEAR_CONTRACT_ID` | `genaaaa-identyclaw-com.near` | `genaaaa-identyclaw-com.near` |
| `MINTING_FEE` | `0.4` | `0.28` |
| `LOG_LEVEL` | `debug` | `info` |
| `WEBHOOK_TEST_ENABLED` | `true` | `false` |
| `LOKI_URL` | `https://grafana47.dihola.io:3100` | `https://grafana46.discernible.io:3100` |
| `SECURITY_OPTIONS.WEBHOOK_TLS_SKIP_VERIFY` | `"true"` | `"true"` |

`NEAR_CONTRACT_ID` is embedded in generated token IDs and signatures; using the wrong contract ID causes token validation failures in the target environment.

### Editing configuration *(this repo)*

When changing a setting:

1. Update [`config/development.json`](../config/development.json) and/or [`config/main.json`](../config/main.json) as appropriate (duplicate shared values in both only when they must stay in sync across branches).
2. Do **not** add application keys to a shared `config/default.json` layer.
3. After swagger auth changes, run `npm run update:permissions` (see [Generated `METHOD_PERMISSION_MAP`](#generated-method_permission_map) below).
4. For secrets, use host `secrets/secrets.env` and [`config/custom-environment-variables.json`](../config/custom-environment-variables.json) — never commit secrets in `config/*.json` except documented dev placeholders.

### Development placeholders *(this repo)*

Committed JSON may include **non-production placeholders** that must be overridden on main:

| Placeholder | Config path | Override on main |
| --- | --- | --- |
| `HMAC-session-secret-is-not-set` | `SECURITY_OPTIONS.SESSION_SECRET` | Set `SECURITY_OPTIONS_SESSION_SECRET` via `secrets/secrets.env` (mapped in `custom-environment-variables.json`) |

Treat [`config/main.json`](../config/main.json) and [`config/development.json`](../config/development.json) as the source of truth for all other tunable values — do not duplicate them in prose checklists.

### Application startup

1. **NODE_ENV is set by the deployment workflow** (not from config files):
   - `development` branch → NODE_ENV: "development" → loads `config/development.json`
   - `main` branch → NODE_ENV: "main" → loads `config/main.json`
2. Application loads `config/{NODE_ENV}.json` based on NODE_ENV value
3. `custom-environment-variables.json` overlays secrets from `secrets/secrets.env`
4. Final config = environment-specific base config + secret overrides from env file

**Important:** NODE_ENV must come from the deployment environment (workflow, container orchestration, or host environment), never from config files. This prevents circular dependencies and ensures the correct config file is loaded.

### Login endpoint path

`LOGIN_RODIT_PATH` defaults to `/api/login` in SDK fallback defaults and should be treated as the canonical configurable default for login-server path resolution.

### Generated `METHOD_PERMISSION_MAP`

`METHOD_PERMISSION_MAP` is generated from [`api-docs/swagger.json`](../api-docs/swagger.json) into the active environment file (`config/development.json` or `config/main.json`). Implementation: [`scripts/update-permissionsmap.js`](../scripts/update-permissionsmap.js).

| Context | Command |
| --- | --- |
| CI / deploy (one branch) | `NODE_ENV` from workflow → updates `config/${NODE_ENV}.json` before Docker build |
| Local / both files in git | `npm run update:permissions` (uses `--all-environments`) |
| Validate | `npm run validate:permissions` |

```bash
# Single environment
NODE_ENV=development node scripts/update-permissionsmap.js --permissions

# Both (commit swagger + map changes together)
npm run update:permissions
```

The generator uses the **last path segment** of each authenticated swagger path (for example `/api/me/identity` → `identity`). Unauthenticated routes are omitted.

---

## Validation

Before the HTTP server listens, startup calls **`validateConfig(logger)`** from the SDK (`config.validate`). It applies `VALIDATION_RULES` (required keys, types, sanity checks—for example `NEAR_RPC_URL` shape, `NEAR_CONTRACT_ID` non-empty, `LOG_LEVEL` allowed values). Failures abort startup and are logged as errors with structured context.

Operators should fix validation errors at the env or `config/` layer rather than patching code.

---

## Visualization via logs

Configuration is observable in these ways:

### 1. Validation phase (`validateConfig`)

During validation the SDK emits:

- **`info`** when validation starts and when it succeeds.
- **`debug`** lines per validated rule (`key: value`), suitable for diagnosing “what did the server think this was?” without dumping the full tree at `info`.

Use **`LOG_LEVEL=debug`** temporarily when diagnosing misconfiguration; avoid permanent `debug` in high-volume main unless you accept the volume and downstream cost.

### 2. Server listen confirmation *(this repo)*

When the listener starts, [`src/app.js`](../src/app.js) logs **`Server started`** with `port`, `env`, and registered endpoints. Use that line plus [`logging-standard.md`](logging-standard.md) for boot correlation.

### 3. Health endpoint

**`GET /health`** returns JSON `{ status, timestamp }` for load balancers and deploy scripts (see [`cicd-deployment-standard.md`](cicd-deployment-standard.md)). It does not expose full configuration.

### Aspirational: resolved startup snapshot

Other services in the RODiT family may log a delayed, redacted **configuration snapshot** after startup. SignPortal does **not** implement `buildStartupConfigSnapshot` today; if added, follow redaction rules in [`logging-standard.md`](logging-standard.md) and document the lag here.

---

## Review checklist (changes to config behavior)

- New tunable behavior uses `config.get` from `@rodit/rodit-auth-be`, not ad-hoc `process.env` in route code.
- Runtime path selection (auth/signing/routing behavior) uses nullish fallback (`??`) unless a documented reason requires truthy fallback (`||`).
- New secrets or credentials stay in host `secrets/secrets.env` / env mapping—not in committed `config/*.json`.
- If a key appears in startup logs, sensitive values are redacted (no raw secrets in log payloads).
- **`custom-environment-variables.json`** is updated when operators need a documented env knob.
- **`VALIDATION_RULES`** (or upstream validation) covers any new mandatory main settings.
- After swagger auth changes, run `npm run update:permissions` and commit the updated `METHOD_PERMISSION_MAP` in the affected `config/<NODE_ENV>.json` file(s).
