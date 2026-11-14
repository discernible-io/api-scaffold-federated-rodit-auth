# Federated RODiT peer scaffold

Reusable pattern so **your API accepts RODiT Passports people already hold**. They prove possession against **your** peer, receive a **peer-minted JWT**, and call your protected routes. Replace the sample hostnames (`api.example.com`, `peer.example.com`) with your own.

This repo is a working peer built on [`@rodit/rodit-auth-be`](https://www.npmjs.com/package/@rodit/rodit-auth-be). The included **CRUDA** comments API is only a sample resource — keep the auth spine, replace CRUDA with your domain.

**NEAR Hackathon:** entry is [`rodit-sdk`](https://github.com/discernible-io/rodit-sdk) — this scaffold is supporting material only.

## Why federation

The Passport home (`https://api.example.com`) issues Passport identity. It does **not** authorize arbitrary third-party APIs.

Each service that wants Passport holders as clients runs as a **peer**:

1. Holds its own RODiT service credentials (NEAR / Vault).
2. Exposes the same login challenge contract (`/api/login/timestamp` → `/api/login`).
3. Mints JWTs valid **only** for that peer’s `apiEndpoint`.
4. Authorizes verbs with `METHOD_PERMISSION_MAP` (or your policy on top of `authenticate`).

Clients remint a JWT **per peer**. Tokens are not portable across home and peers, or across peers.

```text
┌─────────────────────┐         ┌──────────────────────────┐
│ Passport home       │         │ Your federated peer      │
│ api.example.com     │         │ peer.example.com         │
│ Passport identity   │         │ POST /api/login → JWT    │
└─────────┬───────────┘         └────────────┬─────────────┘
          │ Passport keys                    │
          └──────────────┬───────────────────┘
                         ▼
              Agent / app signs challenge
              against YOUR apiEndpoint only
```

## Auth contract (copy this)

| Step | Endpoint | Notes |
| --- | --- | --- |
| 1 | `GET /api/login/timestamp` | Fresh `timestamp` + `timestamp_iso` from **this** peer |
| 2 | Sign locally | UTF-8 `roditid\|accountid + timestamp_iso` (Ed25519 → base64url, no separator) |
| 3 | `POST /api/login` | Exactly one of `timestamp` / `timestamp_iso` + signature → `jwt_token` |
| 4 | Protected calls | `Authorization: Bearer <jwt_token>` |
| 5 | `POST /api/logout` | Invalidate this peer’s session |

OpenAPI is authoritative: [`api-docs/swagger.json`](api-docs/swagger.json) (also `/api-docs`).

### Agents

Set `apiEndpoint` to this peer (`https://peer.example.com:8443`). Login with `GET /api/login/timestamp` then `POST /api/login`, and send `Authorization: Bearer <jwt_token>` on `/api/cruda/*`. Keep the JWT outside model-visible output. A token minted by `https://api.example.com` does not authorize this peer.

Public agent guides (no JWT): `GET /api/mcp/resource/doc:skills`, `GET /.well-known/mcp`, `GET /`.

## What ships with the pattern

| Surface | Role in the pattern |
| --- | --- |
| `/api/login/timestamp`, `/api/login`, `/api/logout` | Federated challenge-response JWT mint |
| `/api/token/claims` | Verify peer JWT after login |
| `/api/cruda/*` | **Sample** protected resource (auth + `METHOD_PERMISSION_MAP`) |
| `/api/sessions/*` | Privileged session admin pattern |
| `/api/mcp/*`, `/mcp` | Login docs for agents (not domain tools) |
| `/health`, `/api-docs` | Ops + contract |

Authorization for CRUDA uses `METHOD_PERMISSION_MAP` in `config/*.json` (`create`, `list`, `read`, `update`, `destroy`, …).

## Turn this into your API

1. Fork or clone; set `SERVICE_NAME`, nginx `server_name`, and OpenAPI `servers` to your peer hostname.
2. Provide RODiT server credentials (`config/custom-environment-variables.json` — NEAR / Vault).
3. Copy `src/protected/cruda.js` → your resource router; mount in `src/app.js` with `authenticate` + `authorize`.
4. Add verb keys to `METHOD_PERMISSION_MAP` (or `npm run update:permissions` after updating swagger).
5. Document paths in `api-docs/swagger.json` so Passport holders and agents integrate against a stable contract.
6. Tell clients: login against **your** `apiEndpoint`; never send a home JWT here.

## Quick start

```bash
npm install
# NEAR / RODiT server credentials — see config/custom-environment-variables.json
npm start
```

Listens on `SERVERPORT` (default **8080**). Behind nginx TLS typically **8443**.

### Shell login smoke test

```bash
BASE=http://127.0.0.1:8080
# 1) GET $BASE/api/login/timestamp
# 2) Sign identifier + timestamp_iso with Passport Ed25519 key → base64url
# 3) POST $BASE/api/login  →  jwt_token
curl -s "$BASE/api/token/claims" -H "Authorization: Bearer $JWT"
curl -s "$BASE/api/cruda/list" -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" -d '{}'
```

## Layout

```
src/app.js                 # bootstrap, mounts authenticate + authorize
src/routes/                # login, discovery, MCP docs, sessions
src/protected/cruda.js     # sample protected resource
src/protected/metricsroutes.js
src/middleware/            # request validation, rate limits
src/services/              # health, NEAR probe, MCP HTTP, startup config
config/                    # default.json + env mapping
api-docs/swagger.json      # federated peer OpenAPI contract
```

## Documentation

| Document | Summary |
| --- | --- |
| [`TODO.md`](TODO.md) | Open work for this scaffold (CI/CD, config layout, docs sync) |
| [`api-docs/swagger.json`](api-docs/swagger.json) | OpenAPI 3.0 — federation model + auth contract |
| [`docs/documentation-standard.md`](docs/documentation-standard.md) | How docs are written, indexed, and cross-referenced |
| [`docs/configuration-standard.md`](docs/configuration-standard.md) | Config sources and secrets |
| [`docs/logging-standard.md`](docs/logging-standard.md) | Winston / Loki |
| [`docs/error-handling-standard.md`](docs/error-handling-standard.md) | Error envelope |
| [`docs/allowed-fallback-standard.md`](docs/allowed-fallback-standard.md) | Permitted config and RPC fallbacks |
| [`docs/cicd-deployment-standard.md`](docs/cicd-deployment-standard.md) | Local Podman deploy, host secrets/TLS |
| [`docs/rpc-configuration.md`](docs/rpc-configuration.md) | `NEAR_NETWORK_CONFIG` options for `roditwallet.sh` |
| [`docs/planned-improvements.md`](docs/planned-improvements.md) | Improvement backlog |
| [`scripts/README-database-init.md`](scripts/README-database-init.md) | SQLite init |

## Standards compliance

Authoritative rules are [discernible-io/docs](https://github.com/discernible-io/docs) `main` at `1c6ed12322f651728bc32235f003882f3770d9b8`. This repo is a peer template, so it is not scored as a live API. Files under [`docs/`](docs/) are a non-authoritative copy. Open gaps live in [`TODO.md`](TODO.md).

| Area | Status | Evidence |
| --- | --- | --- |
| Auth (SDK 10.0.3, timestamp challenge, Bearer JWT) | Met | `src/routes/auth*.routes.js`, swagger login paths |
| Error envelope (`sendError`) | Met | Routes + global 404 / malformed JSON |
| Single config + permission map | Met | `config/default.json`; `npm run validate:permissions` |
| SDK `config.get` (`NEAR_RPC_URL`) | Met | `@rodit/rodit-auth-be` from env / host `secrets.env` / defaults |
| Slim API image | Met | `api.Dockerfile` `node:22.23.4-alpine` digest pin, npm stripped, OpenSSL apk floor |
| Logging (no `console.*` in `src/`) | Met | `*WithContext`; stacks when `LOG_LEVEL=debug` |
| Startup config snapshot | Met | `src/services/startup-config.service.js` |
| Host secrets | Met | `podman run --env-file …/secrets/secrets.env` |
| systemd linger | Met | `scripts/ensure-podman-linger.sh` |
| `GET /health` | Met | `src/services/health.service.js` |
| Local deploy tests | Met | `scripts/run-deployment-api-tests.js` |
| nginx edge | Met | Digest-pinned nginx, `brotli-libs` 1.2.1 floor, deny-by-default CORS, `limit_req` |

### Local verification

```bash
npm run validate:permissions
gitleaks detect --config .gitleaks.toml
node --check src/app.js
API_BASE_URL=http://127.0.0.1:8080 node scripts/run-deployment-api-tests.js
```

After a local pod deploy:

```bash
curl -fsSk "https://127.0.0.1:8443/health" | jq .
loginctl show-user "$(whoami)" -p Linger
podman logs api-idc-container 2>&1 | grep -E 'configuration validated|Resolved configuration'
```

## Stack

- Node.js 22.23.4, Express 4
- `@rodit/rodit-auth-be` 10.0.3 (RODiT authenticate / authorize / login; that package is AGPL-3.0-only)
- SQLite (sessions + sample CRUDA data)
- Winston + optional Loki
- Swagger UI at `/api-docs`
- Optional Podman + nginx (`api.Dockerfile`, `nginx.Dockerfile`)
