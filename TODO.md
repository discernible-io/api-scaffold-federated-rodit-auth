# Federated peer scaffold — template backlog

> **This repository is a template**, not a deployed RODiT API. Copy it to build a peer; do not score missing GHCR/`deploy.yml`, dual-tier host secrets, or production cicd gates as service gaps. Index: [`README.md`](README.md#documentation).

## Template maintenance (optional)

1. **Swagger / permissions examples** — Keep [`api-docs/swagger.json`](api-docs/swagger.json) aligned with the sample CRUDA/auth spine so forks start from a coherent contract (`npm run update:permissions` after swagger auth changes).
2. **Docs for forks** — README pins [discernible-io/docs](https://github.com/discernible-io/docs) `1c6ed12322f651728bc32235f003882f3770d9b8`. Replace the divergent local `docs/` copy with reference-only (or a fresh pin) so forks do not treat it as the standard.
3. **Config shape in the sample** — `config/default.json` is fine for the template. When a **fork** becomes a real dual-tier service, that fork should adopt branch-complete `config/development.json` / `config/main.json` per the configuration standard.
4. **Login challenge nonce** — `GET /api/login/timestamp` still builds the timestamp locally. `@rodit/rodit-auth-be` 10.0.3 exports `createLoginTimestampChallenge()` and asks hosts to return `nonce` with the timestamp pair. Missing nonce is still accepted.

## Deferred (product policy for forks)

- Geolocation middleware (`checkGeolocation`).

## When a fork goes live

The consuming service (not this template) then owns: `.github/workflows/deploy.yml`, host `secrets/secrets.env` + TLS, linger, and tier config. Follow [`cicd-deployment-standard.md`](https://github.com/discernible-io/docs/blob/main/docs/cicd-deployment-standard.md) in that new repo.


## Standards conformance gaps (host audit 2026-10-27)

**Template only** — do not score as a live API.

| Gap | Notes |
| --- | --- |
| Stale vendored `docs/` | Against docs `1c6ed12322f651728bc32235f003882f3770d9b8`: local `docs/cicd-deployment-standard.md` is 3,080 bytes, central is 35,962. README names that pin and says the local copy is not the standard. Drop or replace the vendored tree |
| Residual `npm audit` | After the 10.0.3 pin: 5 low (`sqlite3` toolchain) and 5 moderate (`nodemon`/`minimatch`, `node-vault`/`postman-request`/`uuid`). No forward fix inside the current SDK peer ranges. Do not run `npm audit fix --force` |
