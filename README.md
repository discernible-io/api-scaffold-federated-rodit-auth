# IdentyClaw federated peer API (scaffold)

Reusable pattern for **federated API authentication**: IdentyClaw **Passport** holders prove key possession against **your** peer, receive a **peer-minted JWT**, and call your protected routes.

This repo is a working peer built on [`@rodit/rodit-auth-be`](https://www.npmjs.com/package/@rodit/rodit-auth-be). The included **CRUDA** comments API is only a sample resource — keep the auth spine, replace CRUDA with your domain.

## Why federation

IdentyClaw home (`https://api.identyclaw.com`) issues Passport / HOLA identity. It does **not** authorize arbitrary third-party APIs.

Each service that wants Passport holders as clients runs as a **peer**:

1. Holds its own RODiT service credentials (NEAR / Vault).
2. Exposes the same login challenge contract (`/api/login/timestamp` → `/api/login`).
3. Mints JWTs valid **only** for that peer’s `apiEndpoint`.
4. Authorizes verbs with `METHOD_PERMISSION_MAP` (or your policy on top of `authenticate`).

Clients remint a JWT **per peer**. Tokens are not portable across home and peers, or across peers.

```text
┌─────────────────────┐         ┌──────────────────────────┐
│ IdentyClaw home     │         │ Your federated peer      │
│ api.identyclaw.com  │         │ (this scaffold)          │
│ Passport / HOLA     │         │ POST /api/login → JWT    │
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

### OpenClaw agents

```text
identyclaw_ensure_session({ apiEndpoint: "https://your-peer.example:8443" })
identyclaw_request({ method: "GET", path: "/api/cruda/", apiEndpoint: "https://your-peer.example:8443" })
```

The plugin caches the peer JWT and never returns it to the model. Install:

```bash
openclaw plugins install clawhub:@identyclaw/openclaw-identyclaw-plugin
openclaw skills install clawhub:identyclaw
```

Public agent guides (no JWT): `GET /api/mcp/resource/doc:skills`, `GET /.well-known/mcp`, `GET /`.

## What ships with the pattern

| Surface | Role in the pattern |
| --- | --- |
| `/api/login/timestamp`, `/api/login`, `/api/logout` | Federated challenge-response JWT mint |
| `/api/signclient` | Mint/sign client RODiT scoped to this peer’s routes |
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
NODE_ENV=development npm start
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
src/routes/                # login, discovery, MCP docs, signclient, sessions
src/protected/cruda.js     # sample protected resource
src/protected/metricsroutes.js
src/middleware/            # request validation, rate limits
src/services/              # health, NEAR probe, MCP HTTP, startup config
config/                    # main / development / env mapping
api-docs/swagger.json      # federated peer OpenAPI contract
```

## Documentation

| Document | Summary |
| --- | --- |
| [`api-docs/swagger.json`](api-docs/swagger.json) | OpenAPI 3.0 — federation model + auth contract |
| [`docs/configuration-standard.md`](docs/configuration-standard.md) | Config sources and secrets |
| [`docs/error-handling-standard.md`](docs/error-handling-standard.md) | Error envelope |
| [`docs/logging-standard.md`](docs/logging-standard.md) | Winston / Loki |
| [`docs/BRANCHING.md`](docs/BRANCHING.md) | Branch roles |
| [`docs/security-compliance.md`](docs/security-compliance.md) | Compliance notes |
| [`scripts/README-database-init.md`](scripts/README-database-init.md) | SQLite init |

## Stack

- Node.js 20, Express 4
- `@rodit/rodit-auth-be` 9.x (RODiT authenticate / authorize / login)
- SQLite (sessions + sample CRUDA data)
- Winston + optional Loki
- Swagger UI at `/api-docs`
- Optional Podman + nginx (`api.Dockerfile`, `nginx.Dockerfile`)
