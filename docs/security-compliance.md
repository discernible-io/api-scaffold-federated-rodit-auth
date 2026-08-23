# Security & standards compliance

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-29  
**Last updated:** 2026-08-17 (single config, local Podman deploy)

| | |
|---|---|
| **Scope** | `api-scaffold-federated-rodit-auth` scaffold vs the operational docs in [`docs/`](.) |
| **API role** | Auth reference + **CRUDA** comment showcase (peer APIs) |

## Remaining gaps

| Priority | Standard | Gap | Suggested fix |
|----------|----------|-----|---------------|
| P2 | [`configuration-standard.md`](configuration-standard.md) | SDK has no `config.set`; selected RPC URL is applied via `process.env.NEAR_RPC_URL` | SDK setter |
| P3 | [`documentation-standard.md`](documentation-standard.md) | Keep swagger aligned with CRUDA + auth | Update `api-docs/swagger.json` when adding resources |

**Operator (host, not git):** `~/api-idc-app/secrets/secrets.env`, TLS PEMs under `certs/`, linger (`loginctl enable-linger`).

**Deferred:** geolocation middleware (`checkGeolocation`).

## Summary

| Area | Status | Evidence |
|------|--------|----------|
| Auth (SDK 9.x, timestamp challenge, Bearer JWT) | **Met** | `src/routes/auth*.routes.js`, swagger login paths |
| Error envelope (`sendError`) | **Met** | Routes + global 404 / malformed JSON |
| Single config + permission map | **Met** | `config/default.json`; `npm run validate:permissions` |
| SDK `config.get` | **Nuanced** | RPC fallback writes `NEAR_RPC_URL` via env |
| Slim API image | **Met** | Multi-stage `api.Dockerfile`, npm stripped, `apk` tini |
| Logging (no `console.*` in `src/`) | **Met** | `*WithContext`; stacks when `LOG_LEVEL=debug` |
| Startup config snapshot | **Met** | `src/services/startup-config.service.js` |
| Host secrets | **Met** | `podman run --env-file …/secrets/secrets.env` |
| systemd linger | **Met** | `scripts/ensure-podman-linger.sh` |
| `GET /health` | **Met** | `src/services/health.service.js` |
| Local deploy tests | **Met** | `scripts/run-deployment-api-tests.js` |
| nginx edge | **Met** | Deny-by-default CORS, `limit_req`, JSON gateway errors |
| Documentation index | **Met** | README lists `docs/` |

## Local verification

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
