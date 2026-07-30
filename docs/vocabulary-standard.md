# Vocabulary Standard

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-24

Deployment and configuration in RODiT service repositories use two environment names, aligned with Git branches:

| Term | Branch | `NODE_ENV` | Config file | Nginx config |
| --- | --- | --- | --- | --- |
| **development** | `development` | `development` | `config/development.json` | `nginx/nginx.development.conf` |
| **main** | `main` | `main` | `config/main.json` | `nginx/nginx.main.conf` |

## Use consistently

- Say **main** (not *production*, *prod*, or *live*) for the branch, host, server, credentials, and runtime tier served by `main`.
- Say **development** for the parallel tier served by `development`.
- GitHub Actions secrets use the `_MAIN` and `_DEVELOPMENT` suffixes (for example `SSH_HOST_MAIN`).
- Local Podman deploys use `TARGET=development` (default) or `TARGET=main` (see `scripts/deploy-local-podman.sh`).

## Do not rename

These are tool or ecosystem names, not deployment tiers:

- `npm ci --production` / `npm install --production` — omit dev dependencies in images
- `.env.production.local` — Create React App override filename (not used for branch mapping here)
- **mainnet** — NEAR network name

## Related docs

- [`configuration-standard.md`](configuration-standard.md) — config file layout and `NODE_ENV`
- [`cicd-deployment-standard.md`](cicd-deployment-standard.md) — CI/CD and host setup
