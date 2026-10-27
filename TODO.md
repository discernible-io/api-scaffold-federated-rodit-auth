# Federated peer scaffold — template backlog

> **This repository is a template**, not a deployed IdentyClaw/RODiT API. Copy it to build a peer; do not score missing GHCR/`deploy.yml`, dual-tier host secrets, or production cicd gates as service gaps. Index: [`README.md`](README.md#documentation).

## Template maintenance (optional)

1. **Swagger / permissions examples** — Keep [`api-docs/swagger.json`](api-docs/swagger.json) aligned with the sample CRUDA/auth spine so forks start from a coherent contract (`npm run update:permissions` after swagger auth changes).
2. **Docs for forks** — Prefer pointing at [discernible-io/docs](https://github.com/discernible-io/docs) (reference-only or a fresh pin) rather than maintaining a divergent local `docs/` copy as if it were authoritative.
3. **Config shape in the sample** — `config/default.json` is fine for the template. When a **fork** becomes a real dual-tier service, that fork should adopt branch-complete `config/development.json` / `config/main.json` per the configuration standard.

## Deferred (product policy for forks)

- Geolocation middleware (`checkGeolocation`).

## When a fork goes live

The consuming service (not this template) then owns: `.github/workflows/deploy.yml`, host `secrets/secrets.env` + TLS, linger, and tier config. Follow [`cicd-deployment-standard.md`](https://github.com/discernible-io/docs/blob/main/docs/cicd-deployment-standard.md) in that new repo.


## Standards conformance gaps (host audit 2026-10-27)

**Template only** — do not score as a live API.

| Gap | Notes |
| --- | --- |
| Stale vendored `docs/` | Local `docs/cicd-deployment-standard.md` ~3 KB vs central ~107 KB — prefer reference-only to discernible-io/docs for forks; do not cite the local copy as authoritative |
