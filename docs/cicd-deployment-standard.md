---
title: CI/CD Deployment Standard
date: 2026-05-14
author: Cascade AI Assistant
status: Implemented & Validated
---

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-14

> **Scope:** **discernible-io/docs** publishes standards only. *This repo* means the **consuming service repository** where `docs/` sits at the repo root (next to `src/`, `config/`, `.github/`, etc.), not this standards repository. Concrete values below use **Generic** and **Example (…)** labels only.

## Current Deployment Topology

Deployments use one workflow (`.github/workflows/deploy.yml`) with branch-selected SSH targets:

| Environment | Branch trigger | Workflow | Host path | Pod name | External port | NODE_ENV |
| --- | --- | --- | --- | --- | --- | --- |
| Development | `development` | `.github/workflows/deploy.yml` | `/home/<SSH_USER_DEVELOPMENT>/<app-dir>` | `<service>-pod` | `<port>` | `development` |
| Main | `main` | `.github/workflows/deploy.yml` | `/home/<SSH_USER_MAIN>/<app-dir>` | `<service>-pod` | `<port>` | `main` |

`<app-dir>` is the directory name under the deploy user’s home (e.g. `signportal-app`). The full host path **`APP_DIR` must be derived from `SSH_USER`**, not hardcoded per branch — see [Application directory (`APP_DIR`)](#application-directory-app_dir).

**Example (clienttestapi):** `~/clienttestapi-app` · `clienttestapi-pod` · `7443` on each target host (dev and main may be different machines; same `APP_DIR` name on both).

**Example (SignSanctum):** `~/signsanctum-app` · `signsanctum-pod` · `1443` — same pattern, different names and port.

**Before first deploy:** provision TLS and `secrets/secrets.env` on the host — see [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates). CI pulls images and normalizes cert ownership; it does not create secrets or issue certificates.

## Overview

This guide documents the migration from local Podman image builds to GitHub Container Registry (GHCR)-based builds and deployments. It is designed to be reusable across multiple repositories with similar Podman-based deployment architectures.

> **How to read this document:** Generic placeholders appear first (e.g., `<app-dir>`, `<service>`, `<port>`). **Example (clienttestapi)** values match [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) in that service repository (service-relative; see [`documentation-standard.md`](documentation-standard.md#service-relative-links)). **Example (SignSanctum)** shows the same pattern as [`signsanctum-rodit`](../../signsanctum-rodit) — use it for comparison, not as clienttestapi settings.

## Goals

- Move image builds off the main host and into GitHub Actions CI.
- Publish container images to GitHub Container Registry (GHCR) with immutable, versioned tags.
- Prevent runtime secrets from crossing the network during deployments by storing them on the server.
- Preserve the existing Podman-based runtime on the target host while minimizing changes to the host filesystem layout.
- Enable reproducible, auditable deployments with full version history.
- Block deployment when dependency freshness policy fails by running `scripts/enforce-minimum-package-age.js` before install/build/image publishing.
- Block deployment when [Gitleaks](https://github.com/gitleaks/gitleaks) finds secrets or credentials in the repository content scanned for that workflow run (see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks)).
- Keep rootless Podman pods running after deploy SSH and interactive sessions end by enabling logind **linger** for the deploy user (see [H. systemd linger](#h-systemd-linger-containers-survive-session-logout)).
- Ship **slim production Node images** (no bundled npm/yarn in the runtime layer; static SPAs served from nginx where applicable) — see [Production container images: slim Node runtimes](#production-container-images-slim-node-runtimes).

## Secret scanning with Gitleaks

[Gitleaks](https://github.com/gitleaks/gitleaks) scans git content for committed secrets (API keys, tokens, private keys, connection strings, and similar patterns). Use it in CI as a **mandatory gate in `build-images`**, after checkout and **before** `npm ci`, Docker builds, or image publish—so a finding never reaches GHCR or the deployment host.

Gitleaks complements (does not replace) other controls in this standard:

| Control | Role |
| --- | --- |
| Host `secrets/secrets.env` | Runtime secrets never in git |
| `.gitignore` (`secrets.env`, `*.pem`, etc.) | Keeps local/host material out of commits |
| `enforce-minimum-package-age.js` | Supply-chain freshness |
| **Gitleaks** | Detects secrets already present in tracked files or history |

### When to run

| Trigger | Recommended scope |
| --- | --- |
| Push to `development` or `main` (deploy workflow) | Scan the checked-out tree; use **full git history** (`fetch-depth: 0` on checkout) so reintroduced or historical leaks fail the job |
| Pull requests (optional separate workflow) | Prefer **diff-only** scan (`gitleaks detect` with PR base/head) for faster feedback; still fail on any finding |
| Local pre-push | Same command as CI for early feedback |

Run Gitleaks **before** dependency install and image build. A leaked key in `config/*.json`, `src/`, or docs must fail the job before that content is copied into an image.

### Generic CI integration (`build-images`)

**1. Checkout with full history (deploy branches)**

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

**2. Run Gitleaks (fail the job on any leak)**

Option A — official action (typical for GitHub Actions):

```yaml
- name: Secret scan (Gitleaks)
  uses: gitleaks/gitleaks-action@v2
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Option B — pinned CLI in the runner (same policy, explicit version):

```bash
# Example: install a pinned release, then scan repo root
gitleaks detect --source . --verbose --redact
```

Any non-zero exit must fail `build-images` and stop `test-and-deploy` (same severity as the minimum-package-age gate).

**Suggested step order in `build-images`:**

1. Checkout (`fetch-depth: 0` for deploy workflows).
2. **Gitleaks** secret scan.
3. `node scripts/enforce-minimum-package-age.js`.
4. `npm ci`, permission-map validation, Docker build/push.

### Configuration (`.gitleaks.toml`)

Keep a repo-root **`.gitleaks.toml`** (or `.gitleaks.toml` path passed to `gitleaks detect --config`) for:

- **Allowlists** — documented non-secret placeholders (for example config keys that look like secrets but are overridden on the host per [`configuration-standard.md`](configuration-standard.md)).
- **Path allowlists** — only when a path is guaranteed non-production (avoid broad `allowlists` that hide real leaks).

Review every allowlist entry in code review. Prefer fixing the source or moving values to host `secrets/secrets.env` instead of permanently ignoring a rule.

Do not commit `.gitleaksignore` entries for real credentials; rotate and remove the secret from history when a leak occurred.

### Operator and developer workflow

**Local scan (before push):**

```bash
# Install: https://github.com/gitleaks/gitleaks#installing
gitleaks detect --source . --verbose --redact
```

**If CI fails:**

1. Read the Gitleaks report in the Actions log (file path and rule ID).
2. Remove the secret from the tree; use host `secrets/secrets.env` or env mapping from [`configuration-standard.md`](configuration-standard.md).
3. Rotate the exposed credential (treat it as compromised even if the commit is reverted).
4. If the match is a false positive, add a **narrow** allowlist entry in `.gitleaks.toml` and document why in the PR.

**Example (idclawserver-idc):** wire the step into [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) `build-images` when adopting this standard; add `.gitleaks.toml` before the first enforced run so documented placeholders are allowlisted intentionally.

### What Gitleaks does not do

- Does not scan host `~/<app-dir>/secrets/secrets.env` (not in the build context).
- Does not validate that GitHub Actions secrets are scoped correctly (separate review).
- Does not replace dependency age policy or TLS/host provisioning checks.

## Host runtime: secrets and TLS certificates

Operators provision **secrets** and **TLS material on the deployment host** before (or between) CI runs. GitHub Actions builds images and recreates the Podman pod; it does not copy PEM files or secret values over SSH.

### Git repository vs host application directory

| Layer | Generic | Example (clienttestapi) | Example (SignSanctum) |
| --- | --- | --- | --- |
| Source (clone, PRs, CI build context) | `<service>-rodit` repository | `clienttestapi-rodit` | `signsanctum-rodit` |
| Runtime data on the SSH host | `~/<app-dir>/` | `~/clienttestapi-app/` | `~/signsanctum-app/` |

Keep `certs/`, `logs/`, `data/`, and `secrets/` under **`~/<app-dir>/` only**. Do not commit PEMs or `secrets.env` to the git repository (see [`.gitignore`](../.gitignore) patterns for `*.pem` and `secrets.env`).

### TLS certificates

**Generic**

1. Point DNS **A records** for the environment hostname at the deployment host.
2. Issue or renew a certificate (for example Let's Encrypt) for that hostname.
3. Install **`fullchain.pem`** and **`privkey.pem`** into `~/<app-dir>/certs/`.
4. Align three names: nginx `server_name`, workflow `DOMAIN` (health check), and the certificate **CN/SAN**.
5. On each deploy (or before starting nginx), apply rootless ownership: `podman unshare chown 101:101` on PEMs, **600** on private keys, **644** on public material, **711** on `certs/` — see [Rootless Podman, TLS sidecar, and env-file learnings](#rootless-podman-tls-sidecar-and-env-file-learnings).

**Example (shared host tooling)**

On servers that use the sibling [`infra`](../../infra) repository:

```bash
cd /path/to/infra
sudo ./generate_letsencrypt_cert.sh <hostname> <contact-email>
sudo ./install-certs-to-apps.sh
./verify-certs-in-apps.sh
```

`install-certs-to-apps.sh` copies from `/etc/letsencrypt/live/<hostname>/` into each app's `certs/` directory.

| Host directory | Certificate hostname (`CN`) | Repo |
| --- | --- | --- |
| `~/clienttestapi-app` | `webhook.dihola.io` (dev) / `webhook.discernible.io` (main) | **Example (clienttestapi)** |
| `~/signsanctum-app` | `signsanctum.dihola.io` (dev) / `signsanctum.discernible.io` (main) | **Example (SignSanctum)** |

Issue and install for the hostname that matches the branch you deploy (`development` vs `main`).

After installing PEMs, restart or redeploy so nginx loads them (`sudo ./restart.sh` from `infra`, or push to trigger `.github/workflows/deploy.yml`).

**Domain alignment**

| Environment | Branch | Nginx `server_name` | Workflow `DOMAIN` |
| --- | --- | --- | --- |
| Development | `development` | `webhook.dihola.io` | `webhook.dihola.io` |
| Main | `main` | `webhook.discernible.io` | `webhook.discernible.io` |

**Example (SignSanctum):** `signsanctum.dihola.io` / `signsanctum.discernible.io` with the same branch mapping.

Change nginx configs, `DOMAIN` in `deploy.yml`, and DNS/cert issuance together when renaming a host.

Further detail: [`infra/CERTIFICATE-MANAGEMENT.md`](../../infra/CERTIFICATE-MANAGEMENT.md).

### Runtime secrets (`secrets.env`)

**Generic**

1. Create `~/<app-dir>/secrets/secrets.env` on the **target host** for that environment (development host vs main host).
2. Put **runtime secrets only** in the file (tokens, credentials, base64 key blobs). Non-secret settings belong in committed `config/{NODE_ENV}.json` — see [`configuration-standard.md`](configuration-standard.md).
3. Map keys through `config/custom-environment-variables.json` so the API reads them via `@rodit/rodit-auth-be` `config.get`.
4. Wire the deploy workflow: `podman run --env-file ~/<app-dir>/secrets/secrets.env`.
5. Keep each `KEY=value` on **one line** (especially `*_JSON_B64` values).

**Permissions (rootless Podman deploy user)**

| Path | Mode | Notes |
| --- | --- | --- |
| `~/<app-dir>/secrets/` | `750` | Created by deploy workflow (`chmod 750`) |
| `~/<app-dir>/secrets/secrets.env` | `644` | Must be readable by the API container user when using `--env-file` |
| PEM private key | `600` after `podman unshare chown 101:101` | Applied in deploy workflow before nginx starts |
| PEM certificate chain | `644` after `podman unshare chown 101:101` | Same |

If the API logs `permission denied` on `secrets.env`, set directory **755** and file **644** as in [Permission Denied on secrets.env](#permission-denied-on-secretsenv). Avoid `chmod 640` with `root:root` unless you confirm the deploy user's containers can still read the file.

**Example (clienttestapi) — keys in `secrets.env`**

See [`config/custom-environment-variables.json`](../config/custom-environment-variables.json) and [`configuration-standard.md`](configuration-standard.md). Common entries include `LOKI_BASIC_AUTH`, `NEAR_CREDENTIALS_JSON_B64` (single-line; `base64 -w0` on GNU systems), `NEAR_RPC_URL`, `VAULT_ROLE_ID`, `VAULT_SECRET_ID`.

```bash
nano ~/clienttestapi-app/secrets/secrets.env
chmod 644 ~/clienttestapi-app/secrets/secrets.env
```

**Example (SignSanctum):** same layout under `~/signsanctum-app/secrets/secrets.env` with that service's mapped keys.

Use **development** credentials on the development server's file and **main** credentials on the main server. The workflow never copies this file from GitHub.

### What CI provisions vs what operators provision

| Item | Provisioned by CI / workflow | Provisioned on host by operator |
| --- | --- | --- |
| Container images | Yes (GHCR pull) | — |
| `certs/fullchain.pem`, `certs/privkey.pem` | — | Yes (TLS issuance + install) |
| `secrets/secrets.env` | — | Yes |
| `config/{NODE_ENV}.json` | Baked into API image at build time | — |
| `podman unshare` ownership on PEMs | Yes (each deploy) | Initial PEMs must exist first |
| logind **linger** for deploy user | Yes (`scripts/ensure-podman-linger.sh` on each deploy; persists on host) | Fallback: `sudo loginctl enable-linger <user>` if SSH user cannot self-enable |

## Architecture

### Before (Local Build)
- Entire repo rsynced to main host on every deploy.
- Both API and nginx images built locally via `podman build` on the host.
- Images tagged locally only (`idclawserver-image:latest`, `localhost/idclawserver-nginx:latest`).
- Runtime secrets transmitted from GitHub to host via SSH on every deploy.
- No version history; images lost on cleanup.

### After (GHCR Pull)
- Images built in GitHub Actions CI using `docker/build-push-action@v6`.
- Images pushed to GHCR with immutable SHA tags (`ghcr.io/<org>/<repo>/<image>:${{ github.sha }}`).
- Deploy job pulls pre-built images from GHCR and recreates the pod.
- Runtime secrets stored on the host in `~/<app-dir>/secrets/secrets.env` and injected via `--env-file` (never rsynced from CI).
- GitHub only holds the GHCR pull token; other secrets remain on the host.
- Full version history and audit trail in GHCR.

## Implementation Steps

### 1. Refactor GitHub Actions Workflow

**File:** `.github/workflows/deploy.yml`

Split the workflow into two jobs:

#### Job 1: `build-images`
- **Permissions:** `contents: read`, `packages: write`
- **Steps:**
  1. Checkout code (`fetch-depth: 0` when using full-history Gitleaks on deploy branches).
  2. Run **Gitleaks** as a mandatory secret scan before install/build (see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks)). Any finding must fail `build-images` and stop deployment.
  3. Set up build environment (Node, Docker Buildx, etc.).
  4. Run `node scripts/enforce-minimum-package-age.js` as a mandatory supply-chain gate before `npm ci`, build, or image publishing. Any non-zero exit must fail `build-images` and stop deployment.
  5. Run tests/validation (e.g., permission map generation).
  6. Authenticate to GHCR using `${{ secrets.GITHUB_TOKEN }}`.
  7. Build and push API image: `docker/build-push-action@v6` with tags `${{ github.sha }}` and `latest` (on main).
  8. Build and push nginx image: same as above.
  9. Output image tags for downstream job.

#### Job 2: `test-and-deploy`
- **Depends on:** `build-images`
- **Permissions:** `contents: read` (SSH key for host access)
- **Steps:**
  1. Checkout `scripts/ensure-podman-linger.sh` (sparse checkout is enough).
  2. Install SSH key (`shimataro/ssh-key-action@v2`).
  3. **Enable systemd linger** for the deploy user — see [Rootless Podman: logind linger](#h-systemd-linger-containers-survive-session-logout).
  4. Create required directories on host (`certs`, `logs`, `data`, `nginx`, `secrets`).
  5. Log into GHCR on the host using `GHCR_PULL_TOKEN` secret.
  6. Pull images from GHCR by SHA tag.
  7. Clean up old pod/containers.
  8. Recreate pod and run containers with pulled images.
  9. Verify containers are running.
  10. Run optional HTTPS health check (advisory only; see [Deployment-time API test suite](#deployment-time-api-test-suite)).

**Key differences from old workflow:**
- No rsync of repo files.
- No `podman build` on the host.
- Images pulled by specific SHA tag (immutable).
- Secrets passed via env-file, not as `-e KEY=value` arguments.
- `scripts/enforce-minimum-package-age.js` is a required pre-deploy gate; do not rely only on npm lifecycle hooks or Dockerfile installs to run it implicitly.
- **Gitleaks** is a required pre-deploy gate; do not rely only on local pre-push habits or `.gitignore` to prevent secrets in tracked files.

#### Deployment-time API test suite

Repositories that run an API test suite **inside the API container** once per deploy (not as a separate GitHub Actions test job) must keep the workflow post-deploy HTTPS health check **non-blocking**:

| Concern | Required behavior |
| --- | --- |
| Health check step | `continue-on-error: true`; exit **0** after logging a warning when the probe fails |
| Failed health check | Must **not** fail `test-and-deploy`, roll back containers, or stop the job before deploy steps finish |
| Test suite | Runs after the new API container starts, **independently** of whether the runner reaches `https://${DOMAIN}:${APP_PORT}/health` |
| Individual test outcomes | Logged only; do not fail the workflow or roll back deployment |

The runner often cannot reach the host TLS endpoint even when the pod is healthy on the host. Treat a red health-check step as a signal to verify on the host (`podman logs <app-container-name>`), not as a failed deployment.

### 2. Prepare GitHub Actions Secrets

Create a classic personal access token (PAT) with `read:packages` scope:

1. Go to <https://github.com/settings/tokens/new?scopes=read:packages>.
2. Name it (e.g., `idclawserver-ghcr-pull`).
3. Set expiration (recommend 90 days, rotate regularly).
4. Copy the token.
5. In your repo, go to **Settings → Secrets and variables → Actions**.
6. Create a new secret named `GHCR_PULL_TOKEN` and paste the token.

**Note:** The workflow uses `${{ secrets.GITHUB_TOKEN }}` (built-in) for pushing images in CI. The `GHCR_PULL_TOKEN` is only used on the deployment host for pulling.

#### SSH secrets (GitHub repository settings)

Create these in **Settings → Secrets and variables → Actions** (each RODiT service repo has its **own** copy of the values):

| GitHub secret name | Used when |
| --- | --- |
| `SSH_HOST_MAIN` | `main` branch deploy |
| `SSH_USER_MAIN` | `main` branch deploy |
| `SSH_PRIVATE_KEY_MAIN` | `main` branch deploy |
| `SSH_KNOWN_HOSTS_MAIN` | `main` branch deploy |
| `SSH_HOST_DEVELOPMENT` | `development` branch deploy |
| `SSH_USER_DEVELOPMENT` | `development` branch deploy |
| `SSH_PRIVATE_KEY_DEVELOPMENT` | `development` branch deploy |
| `SSH_KNOWN_HOSTS_DEVELOPMENT` | `development` branch deploy |
| `GHCR_PULL_TOKEN` | Both branches (host `podman login`) |

**Do not** create a secret named `SSH_KNOWN_HOSTS`. In `deploy.yml`, `SSH_KNOWN_HOSTS` is a **workflow `env` alias** only:

```yaml
SSH_KNOWN_HOSTS: ${{ github.ref == 'refs/heads/main' && secrets.SSH_KNOWN_HOSTS_MAIN || secrets.SSH_KNOWN_HOSTS_DEVELOPMENT }}
```

The Install SSH key step passes `known_hosts: ${{ env.SSH_KNOWN_HOSTS }}`, which resolves to `SSH_KNOWN_HOSTS_DEVELOPMENT` or `SSH_KNOWN_HOSTS_MAIN` depending on the branch.

**Populate `SSH_KNOWN_HOSTS_*`:** on a machine that can reach the target host, run `ssh-keyscan -H <same-host-as-SSH_HOST_*>` and paste the full output into the matching GitHub secret (no quotes). The host string must match `SSH_HOST_DEVELOPMENT` or `SSH_HOST_MAIN` exactly (IP vs hostname).

#### Application directory (`APP_DIR`)

One workflow serves **both** `main` and `development`. Main and development often use **different SSH usernames** on different hosts (e.g. `dedalo42` on main, `dedalo43` on development).

**Goals**

| Do | Don’t |
| --- | --- |
| Build `APP_DIR` from `SSH_USER_MAIN` / `SSH_USER_DEVELOPMENT` secrets | Hardcode `/home/dedalo42/...` vs `/home/dedalo43/...` in the workflow |
| Use the same `<app-dir>` suffix on every host (e.g. `signportal-app`) | Set a single `/home/<one-user>/...` that does not match both secrets |
| Keep usernames only in GitHub Secrets | Put deploy account names in committed YAML |

**Service layout:** runtime data lives at `/home/<deploy-user>/<app-dir>/` (e.g. `/home/dedalo42/signportal-app`). The `<app-dir>` name is service-specific; the Linux account comes from secrets.

**GitHub Actions limitation (important)**

In workflow, job, or step `env:` blocks, you **cannot** reference another key in the same block with `${{ env.VAR }}`. These patterns **fail workflow validation**:

```yaml
# INVALID — "Unrecognized named-value: 'env'" at parse time
env:
  SSH_USER: ${{ ... secrets.SSH_USER_MAIN ... }}
  APP_DIR: /home/${{ env.SSH_USER }}/signportal-app

# INVALID — same error in a job-level env:
test-and-deploy:
  env:
    APP_DIR: /home/${{ env.SSH_USER }}/signportal-app
```

After the workflow starts, steps **can** use `${{ env.SSH_USER }}` and `${{ env.APP_DIR }}` in `run:` and `with:` — the restriction applies only when **defining** `env` keys.

**Correct pattern (recommended): workflow-level `APP_DIR`**

Repeat the **same branch expression** as `SSH_USER`, then append `/<app-dir>`. Usernames still come only from secrets; the expression is duplicated once in YAML (same as `SSH_HOST` / `SSH_KNOWN_HOSTS` already are).

```yaml
env:
  SSH_USER: ${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}
  # Must mirror SSH_USER expression — cannot use env.SSH_USER here.
  APP_DIR: /home/${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}/<app-dir>
```

**Example (SignPortal)** — [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

```yaml
env:
  SSH_USER: ${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}
  APP_DIR: /home/${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}/signportal-app
```

With `SSH_USER_MAIN=dedalo42` and `SSH_USER_DEVELOPMENT=dedalo43`, paths resolve to `/home/dedalo42/signportal-app` and `/home/dedalo43/signportal-app` without embedding those names in the repo.

**Optional pattern: set `APP_DIR` in a step (DRY)**

If you want a single secret expression in YAML, set `APP_DIR` at the start of `test-and-deploy` (step `env` **may** reference workflow `env.SSH_USER`):

```yaml
test-and-deploy:
  steps:
    - name: Set APP_DIR from deploy user
      run: echo "APP_DIR=/home/${SSH_USER}/<app-dir>" >> "$GITHUB_ENV"
      env:
        SSH_USER: ${{ env.SSH_USER }}

    - name: Install SSH key
      uses: shimataro/ssh-key-action@v2
      # ...
```

All later steps then use `${{ env.APP_DIR }}`. Prefer the workflow-level duplicate unless you need to avoid repeating the expression.

**Local deploy scripts:** use `APP_DIR="${APP_DIR:-$HOME/<app-dir>}"` so local runs match CI without embedding a Linux account name in the repo.

**Failure mode if violated:** `mkdir -p` fails with `Permission denied` on `/home/<wrong-user>` (SSH user cannot create another account’s home), then `cd $APP_DIR` fails with `No such file or directory` even when `~/signportal-app` exists for a different user on the server.

### 3. Server Preparation

On **each** deployment host (development and main), complete [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates) before the first workflow run.

**Quick bootstrap (generic):**

```bash
mkdir -p ~/<app-dir>/{certs,logs,data,nginx,secrets}
chmod 750 ~/<app-dir>/secrets
chmod 711 ~/<app-dir>/certs

# secrets.env — see configuration-standard.md for key list
nano ~/<app-dir>/secrets/secrets.env
chmod 644 ~/<app-dir>/secrets/secrets.env

# TLS — issue for the environment hostname, then install fullchain.pem + privkey.pem under certs/

# Rootless Podman — enable linger so containers survive SSH logout (once per host/user)
loginctl enable-linger "$(whoami)"
loginctl show-user "$(whoami)" -p Linger   # expect Linger=yes
```

**Example (clienttestapi):** `~/clienttestapi-app`, development cert `webhook.dihola.io`, main `webhook.discernible.io`, secrets keys in [`configuration-standard.md`](configuration-standard.md). CI runs [`scripts/ensure-podman-linger.sh`](../scripts/ensure-podman-linger.sh); local deploy runs the same via [`scripts/deploy-local-podman.sh`](../scripts/deploy-local-podman.sh).

**Directory structure:**

```
~/<app-dir>/
├── certs/              # fullchain.pem, privkey.pem (operator-provisioned)
├── logs/
├── data/
├── nginx/              # reference only; live config is in the image
└── secrets/
    └── secrets.env     # operator-provisioned; --env-file at runtime
```

### 4. Operational Safeguards (Optional)

Add GitHub environment protection rules for main deployments:

1. Go to **Settings → Environments**.
2. Create a new environment named `main`.
3. Add **Selected branches** filter: `main`.
4. Enable **Required reviewers** and add yourself or a team.
5. (Optional) Update the workflow to use the environment:
   ```yaml
   test-and-deploy:
     needs: build-images
     environment: main
     runs-on: ubuntu-latest
   ```

This ensures deployments require manual approval before running.

### 5. Dry-Run Validation

Trigger the workflow and verify:

1. **In GitHub Actions UI:**
   - `build-images` job completes successfully.
   - Images appear in GHCR with commit SHA tag.
   - `test-and-deploy` job completes without errors.

2. **On the main host:**
   ```bash
   # Check images were pulled
   podman images | grep ghcr.io

   # Check pod and containers
   podman pod ls
   podman ps -a

   # Check container logs (including startup config snapshot — see Startup configuration logging)
   podman logs <container-name> | tail -20
   podman logs <api-container-name> 2>&1 | rg 'Configuration validation passed|Resolved configuration at startup'

   # Test the service (adjust endpoint as needed)
   curl -k https://<domain>:<port>/health
   ```

3. **Verify secrets are not exposed:**
   - Check GitHub Actions logs—secrets should not appear in plain text.
   - Confirm `~/<app-dir>/secrets/secrets.env` exists on host with correct permissions.

## Verification Checklist

- [ ] `.github/workflows/deploy.yml` split into `build-images` and `test-and-deploy` jobs.
- [ ] `build-images` runs **Gitleaks** after checkout and before `npm ci` / image builds (see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks)).
- [ ] Repo has `.gitleaks.toml` with reviewed allowlists only for documented non-secrets.
- [ ] `api.Dockerfile` uses a slim production stage (no npm in runtime) per [Production container images: slim Node runtimes](#production-container-images-slim-node-runtimes).
- [ ] `build-images` explicitly runs `node scripts/enforce-minimum-package-age.js` before `npm ci`, Docker builds, or image pushes.
- [ ] `build-images` job uses `docker/build-push-action@v6` to push to GHCR.
- [ ] `test-and-deploy` job pulls images from GHCR by SHA tag.
- [ ] `APP_DIR` uses the same `SSH_USER_*` branch expression as `SSH_USER` (not `env.SSH_USER` inside `env:`; not hardcoded `/home/<username>/...`).
- [ ] `GHCR_PULL_TOKEN` secret created and stored in GitHub Actions.
- [ ] `~/<app-dir>/secrets/secrets.env` created on each target host with correct permissions (directory `750`, file `644` for rootless deploy).
- [ ] TLS PEMs in `~/<app-dir>/certs/` for the environment hostname; `verify-certs-in-apps.sh` (or equivalent) passes.
- [ ] logind **linger** enabled for the deploy user (`loginctl show-user <user> -p Linger` → `yes`), or deploy workflow step succeeded.
- [ ] Workflow triggered and completed successfully.
- [ ] Images appear in GHCR with commit SHA tag.
- [ ] Containers running on main host.
- [ ] Service responding to health checks.
- [ ] No secrets exposed in GitHub Actions logs.
- [ ] `podman logs <api-container>` shows startup config validation (pass/fail) without raw secret values.
- [ ] `podman logs <api-container>` shows a resolved configuration snapshot with `PRESENT-REDACTED` / `ABSENT` for sensitive keys and `source`/`reason` per key.

## Troubleshooting

### Build Job Fails
- Check Docker Buildx setup and authentication to GHCR.
- Verify `docker/build-push-action@v6` syntax and Dockerfile paths.
- Check GitHub Actions logs for build errors.

### Minimum Package Age Gate Fails
- **Error:** `[minimum-package-age] Install blocked` or `[minimum-package-age] Failed to evaluate ...`.
- **Cause:** A dependency resolved to a package version newer than the minimum age policy, or npm metadata could not be evaluated.
- **Fix:** Let the dependency age past the policy window, pin to an older approved version, or add a deliberate exception in `scripts/enforce-minimum-package-age.js` when the risk is accepted. Do not bypass this gate in CI deployment workflows.

### Gitleaks Secret Scan Fails
- **Error:** `leaks detected` / non-zero exit from `gitleaks detect` or `gitleaks-action`.
- **Cause:** A rule matched a secret-like string in a tracked file (or in git history when using full-history scan).
- **Fix:** Remove the value from the repository, move it to host `secrets/secrets.env`, rotate the credential, and re-run. Use `.gitleaks.toml` allowlists only for confirmed false positives—see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks). Do not disable the CI step to unblock deploy.

### Deploy Job Fails
- Verify `GHCR_PULL_TOKEN` is set correctly in GitHub Actions secrets.
- Check SSH key and host connectivity.
- Verify `APP_DIR` resolves to the deploy user’s tree: `/home/${SSH_USER}/<app-dir>/secrets/secrets.env` must exist (not another user’s `~/signportal-app`). See [Application directory (`APP_DIR`)](#application-directory-app_dir).
- **`mkdir: cannot create directory '/home/...': Permission denied` then `cd: ... No such file or directory`:** `APP_DIR` does not match `SSH_USER_*` (e.g. workflow used `/home/dedalo43/...` while secrets deploy as `dedalo42`). Fix secrets or align `APP_DIR` with the [Application directory (`APP_DIR`)](#application-directory-app_dir) pattern.
- **`Unrecognized named-value: 'env'` on `APP_DIR`:** you used `${{ env.SSH_USER }}` inside an `env:` block. Use the duplicated `secrets.SSH_USER_*` expression or a setup step — see [Application directory (`APP_DIR`)](#application-directory-app_dir).
- Check `podman login` output for auth errors.
- Verify image exists in GHCR with the expected SHA tag.

### Permission Denied on secrets.env
- **Error:** `permission denied` when reading `/home/.../secrets/secrets.env`
- **Cause:** File or directory permissions are too restrictive.
- **Fix:**
  ```bash
  sudo chmod 755 ~/<app-dir>/secrets
  sudo chmod 644 ~/<app-dir>/secrets/secrets.env
  ```
- **Why:** Containers run as non-root users (e.g., uid 1000) and need to read the env-file. The file must be world-readable (644) and the directory must be executable (755).

### Containers Won't Start
- Check `podman logs <container-name>` for startup errors.
- Verify volume mounts (certs, logs, data) exist on host.
- Verify env-file is readable by the container user.
- Check Podman resource limits and disk space.

### Containers exit after deploy with exit code 0 (SIGTERM)

- **Symptoms:** `podman ps -a` shows **Exited (0)**; API logs contain `Shutting down gracefully` / `signal":"SIGTERM"`; nothing listens on `<APP_PORT>`; browser shows CORS or network errors with status `(null)`.
- **Cause:** Rootless Podman with **Linger=no**. When the **last login session** for the deploy user ends, systemd stops `user@UID.service` and SIGTERM-stops all containers. Common after GitHub Actions SSH deploy, Cursor/IDE disconnect, or closing the last SSH session — even though deploy itself succeeded minutes earlier.
- **Confirm on host:**
  ```bash
  loginctl show-user <deploy-user> -p Linger
  journalctl --since '1 hour ago' | grep -E 'user@1000|exit.target|Stopping libpod'
  ```
- **Fix:**
  ```bash
  loginctl enable-linger <deploy-user>
  # or: sudo loginctl enable-linger <deploy-user>
  podman pod start <service>-pod
  ```
- **Prevent:** Run [`scripts/ensure-podman-linger.sh`](../scripts/ensure-podman-linger.sh) on every deploy (wired in `.github/workflows/deploy.yml` and `scripts/deploy-local-podman.sh`). **Not fixable** in `api.Dockerfile` or `nginx.Dockerfile` — linger is host logind configuration.
- **Example (clienttestapi):** `<service>-pod` → `clienttestapi-pod`, port `7443`.
- **Example (SignSanctum):** `signsanctum-pod`, port `1443`.

### Health Checks Failing
- Verify the service is listening on the expected port.
- Check firewall rules and port mappings.
- Verify environment variables are correctly injected from the env-file.
- Check service logs for configuration or startup errors.
- **Generic:** Treat the health endpoint as healthy only when the **response body** matches what you expect (e.g. contains `healthy`), not merely when `curl` returns any non-empty body—nginx can return a **502** HTML page while the API is still starting.
- **Deployment-time test suite:** The workflow health step is advisory (`continue-on-error: true`) and must not block deployment or in-container test execution. See [Deployment-time API test suite](#deployment-time-api-test-suite).

### Rootless Podman, TLS sidecar, and env-file learnings

These patterns apply when the **deploy SSH user runs rootless Podman**, the **nginx image runs as a non-root user** (uid **101** in the official `nginx` Alpine image), TLS is **terminated in the nginx sidecar**, and PEM files are **bind-mounted** from `~/<app-dir>/certs/`.

#### A. `NEAR_CREDENTIALS_JSON_B64` (and similar) in `secrets.env`

| | |
| --- | --- |
| **Generic** | Any large `KEY=value` used with `podman run --env-file` must be **one logical line**. Multi-line “pretty” wrapping breaks parsing; only the first line becomes the variable value. |
| **Example (consuming service)** | `NEAR_CREDENTIALS_JSON_B64` must be a **single-line** base64 string. If it wraps, the API may log `Unterminated string in JSON at position …` during credential init. Encode with `base64 -w0 < credentials.json` (GNU) to avoid line wraps. |

#### B. TLS private key: host `nginx` group vs `podman unshare`

| | |
| --- | --- |
| **Generic** | Do not assume the Linux host has a UNIX group named `nginx`. The `nginx` user exists **inside the image**; bind mounts are checked using **host inode permissions** and **user-namespace uid/gid mapping**. |
| **Example (consuming service)** | `sudo chgrp nginx …` fails on RHEL-style hosts with `chgrp: invalid group 'nginx'`. Use **`podman unshare chown 101:101`** on PEM files so ownership matches **container uid 101** in the rootless namespace (host `ls` may show numeric owners such as `524388`—expected). **No** host group named `nginx` is required. |

#### C. TLS directory and file modes (after namespace ownership)

| | |
| --- | --- |
| **Generic** | After `podman unshare chown 101:101` on mounted PEMs, set **private keys** to mode **600** and **public certificate material** to **644**. Use directory mode **711** (`drwx--x--x`) on `certs/` if you want non-owners to **traverse** without **listing** the directory; **755** is also common. The deployment workflow should apply these modes **before** starting the nginx container so every deploy is consistent. |
| **Example (clienttestapi)** | `.github/workflows/deploy.yml` runs `chmod 711 ~/clienttestapi-app/certs`, then `podman unshare chown`/`chmod` on PEMs before `podman run` **clienttestapi-nginx**. Same logic in [`scripts/deploy-local-podman.sh`](../scripts/deploy-local-podman.sh). |
| **Example (SignSanctum)** | Same steps under `~/signsanctum-app` / **signsanctum-nginx**. |

#### D. “Permission denied” on `privkey.pem` in nginx logs

| | |
| --- | --- |
| **Generic** | `nginx: [emerg] cannot load certificate key "…/privkey.pem": … Permission denied` means the **effective uid** of nginx cannot read the key file or cannot traverse a path component. |
| **Example (consuming service)** | Fix with the **`podman unshare chown 101:101`** + **600** pattern in (B) and (C), not by creating a host `nginx` group. |

#### E. Brief HTTP 502 right after container start

| | |
| --- | --- |
| **Generic** | If nginx proxies to an API that performs slow startup (external RPC, SDK init), the first requests may return **502** until the upstream listens. |
| **Example (consuming service)** | NEAR / RODiT initialization can take a few seconds. Wait and retry `/health` on the host. The workflow health step tries at most **5** times (**5s** apart) and does not fail the deploy job. Immediate `curl` after `podman run` is not a reliable signal. |

#### F. Local fast loop (same layout as CI, no registry)

| | |
| --- | --- |
| **Generic** | For “build host == deploy host” troubleshooting, build images with `podman build` and run the **same** pod/volume flags as CI instead of pushing/pulling GHCR. |
| **Example (consuming service)** | Run `./scripts/deploy-local-podman.sh` from the repo (optional `--skip-build`, `TARGET=main` for main-style nginx config). |

#### G. `chmod: Operation not permitted` on `logs/` or `logs/nginx`

| | |
| --- | --- |
| **Generic** | Earlier `podman unshare chown` on log trees can leave directories owned by subordinate uids; later `chmod` from the login user may fail. |
| **Example (consuming service)** | Usually **noise** if the pod still reaches **Running** and `/health` succeeds. Fix once with coordinated `chown`/`chmod` as the deploy user if you want clean deploy logs. |

#### H. systemd linger (containers survive session logout)

| | |
| --- | --- |
| **Generic** | Rootless Podman runs containers as cgroups/units under **`user@<uid>.service`**. With logind **`Linger=no`**, when the **last login session** for that user closes, systemd activates **`exit.target`**, stops **`user@`**, and sends **SIGTERM** to every rootless container (often **exit code 0**, graceful app shutdown). **`--restart=unless-stopped` does not keep the pod up** once the user manager is gone. **Enable linger** for the deploy user so `user@` stays running with no active SSH or graphical session. |
| **Example (clienttestapi)** | `.github/workflows/deploy.yml` runs [`scripts/ensure-podman-linger.sh`](../scripts/ensure-podman-linger.sh) over SSH before pull/deploy. [`scripts/deploy-local-podman.sh`](../scripts/deploy-local-podman.sh) calls the same script in `setup_directories()`. |
| **Example (SignSanctum)** | Same script and workflow step; pod `signsanctum-pod`, `~/signsanctum-app`. |

**Not fixable in the image:** `api.Dockerfile`, `nginx.Dockerfile`, and application entrypoints cannot override logind/session teardown. This is **host configuration**, not container configuration.

**Enable and verify (on each deployment host)**

```bash
# As the deploy user (preferred)
loginctl enable-linger "$(whoami)"

# If self-service is denied by policy
sudo loginctl enable-linger <deploy-user>

# Verify (must show yes before relying on long-running pods)
loginctl show-user <deploy-user> -p Linger
```

**CI workflow step (generic pattern)**

Sparse-checkout `scripts/ensure-podman-linger.sh` on the runner, then pipe it over SSH **before** `podman pull` / `podman pod create`:

```yaml
- name: Checkout deploy scripts
  uses: actions/checkout@v4
  with:
    ref: ${{ github.event.inputs.commit_sha || github.sha }}
    sparse-checkout: |
      scripts/ensure-podman-linger.sh

- name: Enable systemd linger for rootless Podman
  run: |
    ssh ${{ env.SSH_USER }}@${{ env.SSH_HOST }} "DEPLOY_USER=${{ env.SSH_USER }} bash -s" \
      < scripts/ensure-podman-linger.sh
```

The script is idempotent: if linger is already `yes`, it exits successfully. Set **`SKIP_LINGER=1`** only when the host uses rootful Podman or another supervisor that does not depend on `user@` (unusual for this standard).

**Typical timeline (why containers die minutes after a green deploy)**

| Time | Event |
| --- | --- |
| T+0 | GitHub Actions SSH finishes `podman run`; short-lived deploy sessions end. |
| T+0 … T+n | Another session (IDE, manual SSH) may still hold `user@` alive. |
| T+n | Last session removed → `Stopping user@1000.service` → all pod containers receive SIGTERM. |

Symptoms match [Containers exit after deploy with exit code 0](#containers-exit-after-deploy-with-exit-code-0-sigterm).

## Maintenance

### Rotating the GHCR Pull Token
1. Create a new PAT with `read:packages` scope.
2. Update `GHCR_PULL_TOKEN` secret in GitHub Actions.
3. Revoke the old token.
4. Test the next deployment to confirm the new token works.

### Cleaning Up Old Images
On the main host, periodically prune old images:
```bash
podman image prune -a --filter "until=720h"  # Remove images older than 30 days
```

Or configure GHCR retention policies in the GitHub UI.

### Updating the Workflow
If you need to change the workflow (e.g., add new build steps, change image names):
1. Update `.github/workflows/deploy.yml` in the repo.
2. Commit and push to `main`.
3. The workflow will automatically trigger on the next push.

## Reuse for Other Repositories

This pattern is designed to be reusable across multiple repositories with similar Podman-based deployment architectures. Follow these steps to apply it to another repository:

### Step 1: Prepare the Repository

1. **Copy the workflow file:**
   - Copy `.github/workflows/deploy.yml` from a reference service repository to the target repo.
   - Update the following in the `env` section and GitHub settings to match your service:
     - `APP_PORT` — external port (hardcoded constant; must match `nginx.conf` `listen` and `nginx.Dockerfile` `EXPOSE`)
     - `<app-dir>` — directory name under the deploy user’s home (e.g. `myservice-app`); set workflow `APP_DIR` with the same `SSH_USER_*` expression as `SSH_USER` (see [Application directory (`APP_DIR`)](#application-directory-app_dir))
     - `POD_NAME`, `APP_CONTAINER_NAME`, `NGINX_CONTAINER_NAME` — pod and container names (hardcoded constants)
     - `APP_IMAGE_NAME`, `NGINX_IMAGE_NAME` — image names in GHCR (hardcoded constants)
     - `SSH_HOST_MAIN` / `SSH_HOST_DEVELOPMENT` — server IPs (GitHub Secrets)
     - `DOMAIN` — health-check hostname per branch (hardcoded in workflow; must match `nginx/nginx.*.conf` `server_name`)
   
   **Note:** These variables are defined once in the `env` section and reused throughout the workflow via `${{ env.VARIABLE_NAME }}`. Changing them in one place automatically updates all deployment commands.

2. **Copy linger helper and wire the workflow:**
   - Copy [`scripts/ensure-podman-linger.sh`](../scripts/ensure-podman-linger.sh) and add the **Enable systemd linger** step before deploy (see [H. systemd linger](#h-systemd-linger-containers-survive-session-logout)).

3. **Verify all build-required files exist in the repo:**
   - Ensure `api.Dockerfile` and `nginx.Dockerfile` are in the repo root.
   - Apply [Production container images: slim Node runtimes](#production-container-images-slim-node-runtimes) (multi-stage API, no npm in production; SPAs via nginx, not `serve`).
   - Ensure `nginx/nginx.main.conf` and `nginx/nginx.development.conf` exist (required by `nginx.Dockerfile`: `COPY nginx/nginx.${NODE_ENV}.conf`).
   - Ensure `package.json` and `package-lock.json` are present (required by workflow).
   - *Example (SignPortal)* may also ship optional `nginx/docker-entrypoint.d/` scripts; **Example (SignSanctum)** does not require them.
   - Keep `.dockerignore` and `.gitignore` for reference.
   - Add **`.gitleaks.toml`** (allowlists for documented non-secrets only) and a **Gitleaks** step in `build-images` per [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks).
   - **All files referenced in Dockerfiles must be in the repo** — they are copied into the image during the CI build.

4. **Clean up unnecessary files:**
   - Delete build artifacts (`.deb` files, etc.).
   - Delete startup scripts (e.g., `start-service.sh`) — containers run from images.
   - Delete old deployment scripts — use GitHub Actions instead.
   - Keep Dockerfiles, nginx config, package files, and documentation.

5. **Ensure runtime directories are gitignored:**
   - Add to `.gitignore`:
     ```
     /certs/
     /logs/
     /data/
     /secrets/
     ```
   - These directories are created on the host at runtime, not in the repo.
   - The host directory `~/<app-dir>/nginx/` is for reference only; the actual nginx config is baked into the image from the repo.

### Step 2: Configure GitHub Actions Secrets

1. **Create `GHCR_PULL_TOKEN` secret:**
   - Go to **Settings → Secrets and variables → Actions**.
   - Create a new secret named `GHCR_PULL_TOKEN`.
   - Use a classic PAT with `read:packages` scope (can be shared across repos).

2. **Create SSH secrets** per branch — see [SSH secrets (GitHub repository settings)](#ssh-secrets-github-repository-settings). Use `SSH_*_MAIN` and `SSH_*_DEVELOPMENT` suffixes (not `_DEV`, not a bare `SSH_KNOWN_HOSTS` secret).

### Step 3: Prepare the Main Host

1. **Create application directory:**
   ```bash
   mkdir -p ~/<app-dir>/{certs,logs,data,nginx,secrets}
   chmod 750 ~/<app-dir>/secrets
   ```

2. **Enable logind linger** for the deploy user (rootless Podman): [H. systemd linger](#h-systemd-linger-containers-survive-session-logout).

3. **Create `secrets.env`:** Follow [Runtime secrets (`secrets.env`)](#runtime-secrets-secretsenv) in [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates). See also [`configuration-standard.md`](configuration-standard.md).

4. **Provision SSL certificates:** Follow [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates) (TLS subsection). The deploy workflow normalizes PEM ownership for rootless nginx on every run; operators must install the files first.

5. **Install logrotate config (optional):**
   ```bash
   sudo cp nginx/idclaw-nginx-logs.logrotate /etc/logrotate.d/<service>-nginx-logs
   sudo chmod 644 /etc/logrotate.d/<service>-nginx-logs
   ```

### Step 4: Trigger the First Deployment

1. Commit all changes and push to `main`.
2. The workflow will automatically trigger.
3. Monitor **Actions** tab in GitHub for build and deploy progress.
4. Verify on the main host:
   ```bash
   podman images | grep ghcr.io
   podman ps -a
   podman logs <container-name> | tail -20
   curl -k https://<domain>:<port>/health
   ```

### Step 5: Customize for Your Service

Depending on your service, you may need to adjust:

- **Environment variables** in `secrets.env` — add/remove as needed.
- **Dockerfile build steps** — if your service has different dependencies.
- **Nginx configuration** — if your service uses different ports or routing.
- **Health check endpoint** — adjust the curl command in verification.
- **Volume mounts** — if your service needs additional persistent storage.

### Changing Deployment Destination

To deploy to a **different server**, update **GitHub secrets** (`SSH_HOST_*`, `SSH_USER_*`, keys, known hosts) and, if needed, change the **`<app-dir>` suffix** in workflow `APP_DIR`. Do not hardcode Linux account names; usernames come from `SSH_USER_*` secrets only.

**Example:** New main host with deploy user `deploy` and app tree `~/myapp`:

```yaml
# GitHub Secrets: SSH_USER_MAIN=deploy, SSH_HOST_MAIN, ...

env:
  SSH_USER: ${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}
  APP_DIR: /home/${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}/myapp
  # main → /home/deploy/myapp
```

**Example (SignPortal):** `.../signportal-app` with `SSH_USER_MAIN=dedalo42`, `SSH_USER_DEVELOPMENT=dedalo43`.

All SSH commands use `${{ env.APP_DIR }}` and `${{ env.SSH_USER }}` in steps (valid after `env` is defined).

### Checklist for New Repositories

- [ ] `.github/workflows/deploy.yml` copied and customized.
- [ ] Gitleaks runs in `build-images` before `npm ci` / image push; `.gitleaks.toml` reviewed (see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks)).
- [ ] `api.Dockerfile` (and SPA hosting) follow [Production container images: slim Node runtimes](#production-container-images-slim-node-runtimes).
- [ ] `GHCR_PULL_TOKEN` and all `SSH_*_MAIN` / `SSH_*_DEVELOPMENT` secrets created (see [SSH secrets](#ssh-secrets-github-repository-settings)).
- [ ] Main host directory structure created (`certs`, `logs`, `data`, `secrets`, `nginx`).
- [ ] logind linger enabled for deploy user on each host ([H. systemd linger](#h-systemd-linger-containers-survive-session-logout)).
- [ ] `secrets.env` file created on host with all runtime secrets.
- [ ] SSL certificates provisioned in `certs/` directory.
- [ ] Logrotate config installed (optional).
- [ ] First deployment triggered and verified.
- [ ] Service responding to health checks.
- [ ] Containers running and logs clean.
- [ ] Startup configuration logging meets [Startup configuration logging (requirements)](#startup-configuration-logging-requirements).

## Configuration Management: Secrets vs Non-Secrets

**Critical concept:** Separate secrets from non-secret configuration to maintain security and clarity.

For complete configuration architecture, see [`docs/configuration-standard.md`](configuration-standard.md).

### Configuration Sources

| Source | Format | Location | Committed | Purpose |
|--------|--------|----------|-----------|---------|
| `config/{NODE_ENV}.json` | JSON | Repository | ✅ Yes | Non-secret configuration (URLs, ports, feature flags, etc.). Use `config/development.json` on development branch, `config/main.json` on main branch. |
| `secrets/secrets.env` | KEY=VALUE | Host only | ❌ No | Runtime secrets (API keys, credentials, tokens) |
| `config/custom-environment-variables.json` | JSON | Repository | ✅ Yes | Maps secrets from `secrets/secrets.env` to config keys |

### What Goes Where

**In `config/{NODE_ENV}.json` (committed to repo):**
- Service URLs and endpoints
- Port numbers
- Feature flags and toggles
- Log levels
- Service names and versions
- Non-sensitive configuration values
- NODE_ENV setting (development or main)

**In `secrets/secrets.env` (host only, never committed):**
- API keys and tokens
- Database credentials
- Authentication credentials
- Encryption keys
- Private tokens and secrets

### Branch-Specific Configuration

- **`development` branch:** uses `config/development.json` with NODE_ENV: "development"
- **`main` branch:** uses `config/main.json` with NODE_ENV: "main"
- **Benefit:** Merging development → main never overwrites main configuration

### Benefits

1. **Security:** Secrets are never committed to version control
2. **Clarity:** Clear separation between configuration and secrets
3. **Auditability:** Configuration changes are tracked in git; secret changes are not
4. **Consistency:** All applications use the same JSON format for configuration
5. **Simplicity:** Single env-file on host contains only what needs to be secret
6. **Branch safety:** Environment-specific config files prevent accidental overwrites during branch merges

### Startup configuration logging (requirements)

Every API deployed with this standard **must** log effective configuration at container start in a way operators can audit via `podman logs <api-container>` (or the mounted log directory). Requirements apply to all services reusing this pattern (sister APIs included).

#### Config resolution

| Requirement | Detail |
| --- | --- |
| Single resolver | One config module loads merged settings (`config/{NODE_ENV}.json` + `config/custom-environment-variables.json` + host `secrets/secrets.env` via `--env-file`). |
| Env mapping | Every runtime secret override is listed in `config/custom-environment-variables.json`; do not read deploy secrets ad hoc in application code. |
| Provenance | Each logged key must record how it was resolved: `source` (e.g. `environment`, `default.json`, `default`) and optional `reason`. |

#### Two startup log events

| Event | When | Must include | Must not include |
| --- | --- | --- | --- |
| **Validation** | Before the HTTP server listens | Pass/fail; missing/invalid **key names** | Raw secret values |
| **Resolved snapshot** | After listen (delay ~15s if using a remote log sink such as Loki so the record is not dropped) | Sorted map of effective keys with `value`, `source`, `reason`; summary field such as `configKeyCount` | Raw passwords, tokens, private keys, basic auth, credential blobs, or URLs that embed API keys |

#### Redaction

| Value state | Logged `value` for sensitive keys |
| --- | --- |
| Set (non-empty) | `PRESENT-REDACTED` |
| Missing or empty | `ABSENT` |

Sensitive keys include paths whose names indicate secrets (for example `password`, `secret`, `token`, `private`, `basic_auth`, `credential`, `api_key`, `privkey`, `authorization`). Maintain a small allowlist for false positives (for example credential **source mode** strings that are not secret material).

Non-sensitive keys (ports, service names, contract IDs, feature flags) may log real values.

Use the **same redaction helper** for the validation event, resolved snapshot, and any debug per-key lines—never log raw secrets at `debug` on production paths.

#### Log levels

| Level | Content |
| --- | --- |
| `info` | Validation passed/failed, server started, resolved snapshot (redacted) |
| `debug` | Per-key detail only when values are already redacted |
| `error` | Validation failures with key names, not values |

Production default `LOG_LEVEL` should be `info` unless an environment explicitly requires more verbosity.

#### Main vs development

| Environment | Requirement |
| --- | --- |
| **main** | Required secrets logged as `ABSENT` must fail startup or fail `/health` (service policy); document required `secrets.env` keys per host. |
| **development** | May warn on `ABSENT` optional secrets; still use the same redaction rules. |

#### Operator verification (after deploy)

```bash
podman logs <api-container> 2>&1 | rg 'Running startup checks|Configuration validation passed|Resolved configuration at startup'
```

Expect validation messages immediately after container start; expect the resolved snapshot after listen (and any configured delay).

Do not log full large JSON blobs (for example entire permission maps); log presence and size/count instead.

See also [`configuration-standard.md`](configuration-standard.md) for which keys belong in `secrets.env` vs committed JSON.

## Build vs Runtime: Single Source of Truth

**Critical concept:** The repo is the single source of truth for all build artifacts.

### Build Time (GitHub Actions CI)
- Workflow checks out the repo.
- **Gitleaks** runs before dependency installation and image publishing; failure stops the workflow before anything is deployed.
- `scripts/enforce-minimum-package-age.js` runs before dependency installation and image publishing; failure stops the workflow before anything is deployed.
- Dockerfile reads files from the repo:
  - `nginx/nginx.main.conf` or `nginx/nginx.development.conf` → copied into image as `/etc/nginx/nginx.conf` via `nginx.${NODE_ENV}.conf`
  - `src/` → copied into API image
  - `package.json`, `package-lock.json` → dependencies installed
- Images are built and pushed to GHCR.

### Runtime (Main Host)
- Workflow pulls pre-built images from GHCR.
- **No files are copied from the repo to the host.**
- All configuration and scripts are **already inside the image** (baked in during build).
- Host directories (`certs/`, `logs/`, `data/`, `secrets/`) are for runtime data only.
- The host directory `~/<app-dir>/nginx/` is for **reference only** — the actual nginx config is inside the container image.

### Key Takeaway
- **Repo files** → Docker build (CI) → Image → GHCR → Deploy pulls image
- **Host directories** → Runtime data only (logs, certs, persistent data)
- **Single source:** The repo. Everything else is derived from it.

## Production container images: slim Node runtimes

Node-based API and SPA images should ship **only what runs in production**. The official `node:*-alpine` image includes **npm**, **npx**, and often **yarn** under `/usr/local/lib/node_modules/npm/`. Trivy frequently reports **HIGH** findings on those tooling dependencies (`glob`, `tar`, `cross-spawn`, `minimatch`) even when `app/node_modules` is clean—they are **not** your application code paths unless you invoke them at runtime.

**Operational scanning:** Host weekly scans and CI gates are described in the sibling [`infra`](../../infra) repo (`scan-containers-vulnerabilities-weekly.sh`, `container-vulnerability-scan.yml`). Rebuild and redeploy after Dockerfile changes so GHCR tags match the slim image.

### Why this matters

| Symptom in Trivy | Typical cause | Runtime risk |
| --- | --- | --- |
| `Node.js (node-pkg)` block lists `cross-spawn`, `glob`, `tar` | Bundled **npm** in the image | Low if the app never shells out to npm; still noise in compliance scans |
| `app/node_modules/...` all `0`, aggregate block still HIGH | Same—scanner rolls up npm’s tree | Fix the **image**, not only `package-lock.json` |
| `serve` / `npm` in mintclient-style images | Global static server + production `npm ci` in final stage | Extra attack surface; prefer nginx for static assets |

**Goal:** Production stage contains **`node`**, your app tree, and **runtime** `node_modules` only—no package manager CLI, no global `serve`, no build-only devDependencies.

### Pick one pattern per app type

#### A. API containers (Express / Node HTTP server) — **recommended default**

Use a **multi-stage** build: install dependencies in a **builder** stage; copy artifacts into a **production** stage; **remove npm** from the runtime image.

| Stage | Base | Actions |
| --- | --- | --- |
| **builder** | `node:20-alpine` | `COPY package*.json` → `npm ci` (or `npm ci --omit=dev` if no compile step) → `COPY` source |
| **production** | `node:20-alpine` | `apk add --no-cache tini` → non-root user → `COPY --from=builder` → **delete npm/npx** → `CMD ["node", "src/app.js"]` |

**Generic `api.Dockerfile` (production stage excerpt):**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

FROM node:20-alpine AS production
RUN apk add --no-cache tini \
    && adduser -D -H -s /sbin/nologin nodeuser \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder --chown=nodeuser:nodeuser /app ./
USER nodeuser
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/app.js"]
```

**Example (SignSanctum):** [`api.Dockerfile`](../api.Dockerfile) implements this pattern (Alpine `tini` from `apk`, npm removed in production).

**Migrate from single-stage API Dockerfiles:** **Example (SignPortal)** and **Example (clienttestapi)** historically used one `FROM node:20-alpine` layer with `npm install` / `npm ci` and left npm in the image. Port them to the two-stage pattern above; use `npm ci --omit=dev` in builder unless a compile step needs devDependencies.

**Optional hardening (same pattern):**

- Pin base tag or digest, e.g. `node:20-alpine3.21`, and rebuild on a schedule for **Node runtime** CVEs.
- Prefer `npm ci` over `npm install` in CI/build for reproducible lockfiles.
- Do not download a static `/tini` binary when `apk add tini` is available (fewer supply-chain fetches).

#### B. Static SPA (React / Parcel / Vite build output) — **prefer nginx, not Node + `serve`**

SPAs need a static file server in production, not a full Node toolchain.

| Approach | Production image | npm in prod? | Notes |
| --- | --- | --- | --- |
| **Recommended** | Existing **`nginx` sidecar** in the Podman pod | No | Build in CI/builder; copy `dist/` into `nginx.Dockerfile` or mount from builder artifact |
| **Acceptable** | `nginx:alpine` only in app slot | No | Same pod pattern as this standard (nginx terminates TLS, serves `dist/`) |
| **Avoid** | `node:20-alpine` + `npm install -g serve` | Yes (npm + serve deps) | Common source of false-positive HIGHs; keep Node only in **builder** |

**Generic two-stage SPA build:**

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
ARG APP_BUILD_ENV=main
ENV NODE_ENV=${APP_BUILD_ENV}
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Prefer serving dist from nginx.Dockerfile / <service>-nginx container, not:
# FROM node:20-alpine + npm install -g serve
```

**Example (mintclient):** [`react.Dockerfile`](../../mintclient-idc/react.Dockerfile) today runs `npm ci --production` and `npm install -g serve` in the runtime stage—migrate to **builder-only Node** and static hosting via **mintclient-nginx** (or bake `dist/` into the nginx image).

#### C. Newer `node:*-alpine` base only (partial fix)

Bumping `node:20-alpine` to the latest patch reduces **Node runtime** CVEs but **does not** remove npm’s vulnerable dependency tree if npm remains installed. Use this **together with** pattern A or B, not instead of removing npm from production.

#### D. Distroless (advanced)

`gcr.io/distroless/nodejs20-debian12` — no shell, no npm; suitable when the app needs only `node` and compiled assets. Higher operational friction (debugging, native modules). Use when policy requires minimal images beyond Alpine + stripped npm.

### What stays in the builder vs production image

| Artifact | Builder | Production (API pattern A) |
| --- | --- | --- |
| `package-lock.json` | Yes (for `npm ci`) | Optional; not required if `node_modules` copied |
| devDependencies | Only if needed to compile/test | No |
| `npm`, `npx`, `yarn` | Yes | **No** — remove or use distroless |
| `src/`, `config/` | Yes | Yes (API) |
| `dist/` (SPA) | Yes | Copy into nginx image, not Node runtime |

### CI and verification

1. **`build-images`** builds the Dockerfile; no change to deploy pull semantics.
2. After adopting pattern A/B, run Trivy on the new GHCR tag—expect the rolled-up **`Node.js (node-pkg)`** HIGH count from npm tooling to drop for API images.
3. **`trivy fs`** on the repo (infra weekly script / `container-vulnerability-scan.yml`) still catches vulnerable **application** lockfile dependencies before image publish.

**Checklist when changing Dockerfiles:**

- [ ] Production stage has **no** `/usr/local/lib/node_modules/npm` (or uses distroless).
- [ ] API images use **`node …`** as `CMD`, not `npm start`.
- [ ] SPA images do **not** use `serve` or global npm in the runtime layer.
- [ ] Base image tag/digest updated deliberately (not only `latest`).
- [ ] Image rebuilt, pushed to GHCR, and deployed so the running tag matches the slim Dockerfile.

### Related troubleshooting

| Issue | Check |
| --- | --- |
| Trivy clean on `app/node_modules` but noisy `Node.js (node-pkg)` | Remove npm from **production** stage (this section). |
| App works locally with `npm start` but not in container | `CMD` must invoke **`node`** and the correct entry file (e.g. `src/app.js`). |
| Native modules fail after slimming | Build addons in **builder**; copy full `node_modules` to production. |

## Host Directory Structure

After deployment, the main host has the following directory structure under `~/<app-dir>/`:

```
~/<app-dir>/
├── certs/              # SSL/TLS certificates (mounted read-only into nginx)
│   ├── fullchain.pem   # Full certificate chain
│   └── privkey.pem     # Private key (deploy applies rootless ownership + 600 via workflow)
├── logs/               # Container logs (mounted from containers)
│   ├── nginxaccess.log # Nginx access logs
│   ├── nginxerror.log  # Nginx error logs
│   └── nginx/          # Nginx-specific logs
├── data/               # Persistent application data (mounted read-write)
│   └── (application-specific files)
├── nginx/              # Nginx configuration reference
│   └── (optional reference files; live config is in the image as /etc/nginx/nginx.conf)
└── secrets/            # Runtime environment variables
    └── secrets.env     # Operator-provisioned; typically chmod 644 for --env-file
```

### Directory Purposes

| Directory | Purpose | Mounted | Writable | Notes |
|-----------|---------|---------|----------|-------|
| `certs/` | SSL/TLS certificates | Yes (read-only) | No | Operator-provisioned; see [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates) |
| `logs/` | Container logs | Yes | Yes | Logs from running containers; can be pruned periodically |
| `data/` | Persistent data | Yes | Yes | Application-specific data; backed up separately |
| `nginx/` | Nginx config reference | No | No | For reference only; actual config is in the image |
| `secrets/` | Runtime secrets | No | No | `secrets.env` loaded via `--env-file`; never mounted as a volume |

### Deleted Directories

The following directories were removed as they are no longer needed:

- `config/` — Application config (baked into Docker image at build time)
- `src/` — Source code (baked into Docker image at build time)
- `scripts/` — Build scripts (no longer used; builds happen in CI)
- `docs/` — Documentation (available in main repo)
- `api-docs/` — API documentation (available in main repo)
- *Other repos may list `references/` or vendored `sdk/`; **a typical consuming service** uses `@rodit/rodit-auth-be` from npm, not a local `sdk/` tree.*
- `public/` — Static files (baked into Docker image if needed)
- `.git/`, `.github/`, `.windsurf/` — Version control and editor config (not needed on host)
- `*.Dockerfile` — Dockerfile files (images are in GHCR)
- `package.json`, `package-lock.json` — Dependencies (installed in image)
- Build artifacts (`.deb` files, etc.)

## Multi-Environment Deployment (Development & Main)

This section documents the setup for deploying different branches to isolated environments (development and main servers).

### Overview

The workflow supports two deployment branches:
- **`development` branch** → deploys to development server
- **`main` branch** → deploys to main server

Each environment has completely isolated SSH credentials, hosts, and configuration.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub Repository                        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  development branch          main branch                     │
│       ↓                            ↓                         │
│  [GitHub Actions CI]         [GitHub Actions CI]            │
│       ↓                            ↓                         │
│  Build & Push Images         Build & Push Images            │
│  (GHCR)                      (GHCR)                          │
│       ↓                            ↓                         │
│  Pull SSH_*_DEVELOPMENT      Pull SSH_*_MAIN                │
│  (SSH_KNOWN_HOSTS_DEVELOPMENT) (SSH_KNOWN_HOSTS_MAIN)       │
│       ↓                            ↓                         │
│  Deploy to Development Server  Deploy to Main Server        │
│  (SSH_HOST_DEVELOPMENT)      (SSH_HOST_MAIN)                │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### GitHub Secrets Configuration

Create the following secrets in **Settings → Secrets and variables → Actions**:

#### Main secrets (main branch)
- `SSH_HOST_MAIN` — Main server IP address
- `SSH_USER_MAIN` — SSH username for main server
- `SSH_PRIVATE_KEY_MAIN` — SSH private key for main server
- `SSH_KNOWN_HOSTS_MAIN` — Host key fingerprint for main server

#### Development Secrets (development branch)

See [SSH secrets (GitHub repository settings)](#ssh-secrets-github-repository-settings): `SSH_HOST_DEVELOPMENT`, `SSH_USER_DEVELOPMENT`, `SSH_PRIVATE_KEY_DEVELOPMENT`, `SSH_KNOWN_HOSTS_DEVELOPMENT`.

#### Hardcoded Workflow Constants
Defined directly in the workflow `env` section (workflow or job) — not stored in GitHub Secrets or Variables:
- `APP_PORT: <port>` — Fixed by the container/nginx architecture; same for both environments.
- `DOMAIN` — Hostname for the post-deploy HTTPS health check (`https://${DOMAIN}:${APP_PORT}/health`). Chosen by branch in `deploy.yml`; must match `server_name` in the nginx config baked into the image for that branch.

#### Branch-selected workflow `env` (secrets + `<app-dir>` suffix)
- `SSH_USER` — `SSH_USER_MAIN` or `SSH_USER_DEVELOPMENT` by branch.
- `APP_DIR` — `/home/<same SSH_USER expression>/<app-dir>`. **Must** repeat the `SSH_USER` secret expression (cannot use `${{ env.SSH_USER }}` in the same `env:` block). See [Application directory (`APP_DIR`)](#application-directory-app_dir).

**Where domains actually live**

| Environment | Branch | Nginx `server_name` | Workflow `DOMAIN` | Example (clienttestapi) |
| --- | --- | --- | --- | --- |
| Development | `development` | in `nginx/nginx.development.conf` | same as `server_name` | `webhook.dihola.io` |
| Main | `main` | in `nginx/nginx.main.conf` | same as `server_name` | `webhook.discernible.io` |

**Example (SignPortal):** `signportal.dihola.io` / `signportal.discernible.io`, port `8443`.

Do not add `DOMAIN_MAIN` / `DOMAIN_DEV` GitHub Variables—they duplicate values already in `deploy.yml` and nginx configs. Change nginx configs, `DOMAIN` in `deploy.yml`, and DNS/certs together when renaming a host.

#### Shared Secrets
- `GHCR_PULL_TOKEN` — GitHub Container Registry pull token (shared across both environments)

### Workflow Configuration

The workflow uses conditional expressions to select the correct secrets based on the branch:

```yaml
# Generic pattern
on:
  push:
    branches: [ main, development ]

env:
  SSH_HOST: ${{ github.ref == 'refs/heads/main' && secrets.SSH_HOST_MAIN || secrets.SSH_HOST_DEVELOPMENT }}
  SSH_USER: ${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}
  SSH_PRIVATE_KEY: ${{ github.ref == 'refs/heads/main' && secrets.SSH_PRIVATE_KEY_MAIN || secrets.SSH_PRIVATE_KEY_DEVELOPMENT }}
  # SSH_KNOWN_HOSTS is workflow env only — sources SSH_KNOWN_HOSTS_MAIN or SSH_KNOWN_HOSTS_DEVELOPMENT secrets
  SSH_KNOWN_HOSTS: ${{ github.ref == 'refs/heads/main' && secrets.SSH_KNOWN_HOSTS_MAIN || secrets.SSH_KNOWN_HOSTS_DEVELOPMENT }}
  APP_DIR: /home/${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}/<app-dir>
  DOMAIN: ${{ github.ref == 'refs/heads/main' && '<main-host>' || '<dev-host>' }}
  APP_PORT: <port>             # hardcoded constant
```

```yaml
# Example (clienttestapi)
env:
  SSH_HOST: ${{ github.ref == 'refs/heads/main' && secrets.SSH_HOST_MAIN || secrets.SSH_HOST_DEVELOPMENT }}
  SSH_KNOWN_HOSTS: ${{ github.ref == 'refs/heads/main' && secrets.SSH_KNOWN_HOSTS_MAIN || secrets.SSH_KNOWN_HOSTS_DEVELOPMENT }}
  APP_DIR: /home/${{ github.ref == 'refs/heads/main' && secrets.SSH_USER_MAIN || secrets.SSH_USER_DEVELOPMENT }}/clienttestapi-app
  DOMAIN: ${{ github.ref == 'refs/heads/main' && 'webhook.discernible.io' || 'webhook.dihola.io' }}
  APP_PORT: 7443
```

**How it works:**
- Pushing to `main` → uses `*_MAIN` secrets for SSH; `DOMAIN=webhook.discernible.io` for the health check; `APP_DIR=/home/<SSH_USER_MAIN>/clienttestapi-app`
- Pushing to `development` → uses `*_DEVELOPMENT` secrets for SSH; `DOMAIN=webhook.dihola.io` for the health check; `APP_DIR=/home/<SSH_USER_DEVELOPMENT>/clienttestapi-app`
- **Example (SignPortal):** `APP_DIR` ends with `/signportal-app`; usernames from secrets only (e.g. `dedalo42` / `dedalo43`)
- `APP_PORT` is a hardcoded constant — same external port on both hosts
- All downstream deploy steps use `${{ env.APP_DIR }}` and `${{ env.SSH_USER }}`
- Merging `development` into `main` never overwrites main infrastructure settings

### Workflow Constants Reference

#### Hardcoded constants (workflow `env` section)

| Constant | Generic form | Example (clienttestapi) | Example (SignSanctum) | Defined in |
|----------|-------------|---------------------------|------------------------|------------|
| `APP_PORT` | `<port>` | `7443` | `1443` | `nginx.Dockerfile` `EXPOSE`, nginx `listen` |
| `APP_DIR` | `/home/${{ … secrets.SSH_USER_* … }}/<app-dir>` | same expression + `clienttestapi-app` | same expression + `signsanctum-app` | Workflow `env`; mirrors `SSH_USER` — [Application directory (`APP_DIR`)](#application-directory-app_dir) |
| `POD_NAME` | `<service>-pod` | `clienttestapi-pod` | `signsanctum-pod` | Podman pod name |
| `APP_CONTAINER_NAME` | `<service>-container` | `clienttestapi-container` | `signsanctum-container` | Must match nginx `proxy_pass` hostname |
| `NGINX_CONTAINER_NAME` | `<service>-nginx` | `clienttestapi-nginx` | `signsanctum-nginx` | Podman container name |
| `REGISTRY` | `ghcr.io` | `ghcr.io` | GitHub Container Registry |
| `HEALTH_CHECK_MAX_ATTEMPTS` | `<count>` | `5` | Post-deploy HTTPS probes from the runner (advisory) |
| `HEALTH_CHECK_INTERVAL` | `<seconds>` | `5` | Seconds between health check attempts |

These are **not secrets** and have **no environment-specific variants** (`_MAIN` / `_DEVELOPMENT`). They are fixed by the container and network architecture and apply equally to both `main` and `development` branch deployments.

#### Port architecture

The sidecar pod has two containers sharing a network namespace:

```
External client
      |
   <APP_PORT> (pod external port, e.g. podman pod create -p 1443:1443)
      |
 [nginx container]  — listens on <APP_PORT> ssl (nginx.*.conf + nginx.Dockerfile EXPOSE)
      |
   8080 (internal, pod-local, never exposed externally)
      |
 [api container]    — SERVERPORT in config (typically 8080)
```

- `APP_PORT` is the **external** pod port. It must match nginx `listen` and `nginx.Dockerfile` `EXPOSE`.
- **Example (clienttestapi):** `7443`, `proxy_pass http://clienttestapi-container:8080`.
- **Example (SignPortal):** `8443`, `proxy_pass http://signportal-container:8080`.
- `APP_CONTAINER_NAME` must match the hostname in nginx `proxy_pass` (Podman pod DNS uses container names).

Changing any of these values requires coordinated updates across `nginx/nginx.*.conf`, `nginx.Dockerfile`, `api.Dockerfile`, config files, and `deploy.yml`.

#### APP_DIR layout

`~/<app-dir>` is the host directory where runtime data is stored. It is created by the workflow on first deploy and is never committed to the repository.

```
# Generic
~/<app-dir>/
├── certs/      # TLS PEMs (operator-provisioned; see Host runtime section)
├── logs/       # Container logs
├── data/       # Persistent application data
├── nginx/      # Reference only
└── secrets/    # secrets.env (never committed)

# Example (clienttestapi)
~/clienttestapi-app/

# Example (SignPortal)
~/signportal-app/
```

### Configuration files per branch

**Generic:** Non-secret settings live in `config/{NODE_ENV}.json` on the branch being built. Secrets (for example `LOKI_BASIC_AUTH`) stay in host `secrets/secrets.env` per environment — not in committed JSON.

**Example (clienttestapi):** `config/development.json` on the `development` branch and `config/main.json` on `main`. The workflow sets `NODE_ENV` to `development` or `main` so the API loads the matching file from the image. See [`configuration-standard.md`](configuration-standard.md).

### Setting Up SSH Credentials

For each environment, generate or obtain SSH credentials:

#### 1. Generate SSH Key Pair (if needed)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_rsa_dev -N ""
ssh-keygen -t ed25519 -f ~/.ssh/id_rsa_main -N ""
```

#### 2. Add Public Key to Server
```bash
# On development server
cat ~/.ssh/id_rsa_dev.pub | ssh deploy@dev-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

# On main server
cat ~/.ssh/id_rsa_main.pub | ssh deploy@main-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

#### 3. Get SSH Known Hosts
```bash
# For development server
ssh-keyscan -H dev-server-ip >> ~/.ssh/known_hosts
ssh-keyscan -H dev-server-ip

# For main server
ssh-keyscan -H main-server-ip >> ~/.ssh/known_hosts
ssh-keyscan -H main-server-ip
```

Copy the output and store in GitHub Secrets as `SSH_KNOWN_HOSTS_DEVELOPMENT` and `SSH_KNOWN_HOSTS_MAIN` (not `SSH_KNOWN_HOSTS` — that name is only the workflow `env` alias).

#### 4. Store Private Keys in GitHub Secrets
```bash
# Copy the private key content
cat ~/.ssh/id_rsa_dev
cat ~/.ssh/id_rsa_main
```

Paste into GitHub Secrets as `SSH_PRIVATE_KEY_DEVELOPMENT` and `SSH_PRIVATE_KEY_MAIN`.

### Development Workflow

1. **Create feature branches** from `development`:
   ```bash
   git checkout development
   git pull origin development
   git checkout -b feature/my-feature
   ```

2. **Commit and push to feature branch:**
   ```bash
   git add .
   git commit -m "Add my feature"
   git push origin feature/my-feature
   ```

3. **Create a pull request** to `development` for code review.

4. **Merge to development** after approval:
   ```bash
   # GitHub UI or CLI
   gh pr merge feature/my-feature --squash
   ```
   - This triggers the workflow to deploy to the **development server**.
   - Test the feature on the development server.

5. **Merge to main** when ready for main:
   ```bash
   git checkout main
   git pull origin main
   git merge development
   git push origin main
   ```
   - This triggers the workflow to deploy to the **main server**.

### Verification Checklist

- [ ] All `SSH_*_MAIN` and `SSH_*_DEVELOPMENT` secrets created in GitHub.
- [ ] `GHCR_PULL_TOKEN` secret created.
- [ ] Development server SSH key added to `~/.ssh/authorized_keys`.
- [ ] Main server SSH key added to `~/.ssh/authorized_keys`.
- [ ] `config/development.json` and `config/main.json` contain environment-appropriate non-secret values on their branches.
- [ ] Each target host has its own `secrets/secrets.env` and TLS PEMs under `certs/`.
- [ ] Each target host has `Linger=yes` for the deploy user (`loginctl show-user … -p Linger`).
- [ ] Push to `development` branch and verify deployment to dev server.
- [ ] Push to `main` branch and verify deployment to main server.
- [ ] Verify containers are running on correct servers.
- [ ] Verify configuration is correct for each environment.
- [ ] Startup configuration logging verified on each host (`podman logs` — see [Startup configuration logging (requirements)](#startup-configuration-logging-requirements)).

### Troubleshooting Multi-Environment Deployments

#### Workflow deploys to wrong server
- **Cause:** Secrets are named incorrectly or branch name doesn't match.
- **Fix:** Verify secret names match exactly (`SSH_HOST_MAIN`, `SSH_HOST_DEVELOPMENT`, etc.) and branch names are `main` and `development`.

#### SSH authentication fails
- **Cause:** Private key doesn't match public key on server, or `SSH_KNOWN_HOSTS_DEVELOPMENT` / `SSH_KNOWN_HOSTS_MAIN` does not match `SSH_HOST_*`.
- **Fix:**
  1. Verify public key is in server's `~/.ssh/authorized_keys`.
  2. Re-run `ssh-keyscan -H <same-as-SSH_HOST_*>` and update the matching `SSH_KNOWN_HOSTS_*` GitHub secret (not a secret named `SSH_KNOWN_HOSTS`).
  3. Test SSH locally: `ssh -i ~/.ssh/id_rsa_dev deploy@dev-server`

#### Configuration not applied
- **Cause:** Wrong `NODE_ENV`, missing `config/{NODE_ENV}.json` on the built branch, or secrets not in host `secrets.env`.
- **Fix:**
  1. Verify the workflow sets `NODE_ENV` for the branch (`development` vs `main`).
  2. Verify `config/development.json` or `config/main.json` exists on the branch that was built.
  3. Verify `~/<app-dir>/secrets/secrets.env` on that host and check container logs for config loading errors.

## Success Criteria

✅ **Deployment is successful when:**
- Gitleaks and minimum-package-age gates pass in `build-images`.
- Images build and push to GHCR without errors.
- Images pull on the correct server (dev or main) without auth errors.
- Containers start and remain running on the correct server after all login sessions end (`Linger=yes` for deploy user).
- Service responds to health checks on the correct server (post-deploy workflow probe is optional; job still succeeds if not).
- No secrets appear in GitHub Actions logs.
- Deployment completes in under 10 minutes.
- Host directory structure matches the documented layout above.
- Development branch deployments only affect the development server.
- Main branch deployments only affect the main server.

## Future: Meaningful Development/Main Split

Using separate names/paths on the same host helps avoid collisions, but both environments still share one failure domain. For a meaningful split, use separate hosts:

- **Main host** (current)
- **Development host** (new)

Then map each environment to its own workflow, host credentials, and DNS endpoint. The multi-environment deployment section above documents the workflow configuration needed to support this separation.

---

## Setup Checklist

### Phase 1: GitHub Configuration (5 min)

**GitHub repo → Settings → Secrets and variables → Actions**

**Main secrets (main branch):**
- [ ] `SSH_HOST_MAIN` — Main server IP (generic: `<main-ip>`)
- [ ] `SSH_USER_MAIN` — SSH username
- [ ] `SSH_PRIVATE_KEY_MAIN` — SSH private key content
- [ ] `SSH_KNOWN_HOSTS_MAIN` — Output of `ssh-keyscan -H <same-as-SSH_HOST_MAIN>`

**Development Secrets (development branch):**
- [ ] `SSH_HOST_DEVELOPMENT` — Development server IP (generic: `<dev-ip>`)
- [ ] `SSH_USER_DEVELOPMENT` — SSH username
- [ ] `SSH_PRIVATE_KEY_DEVELOPMENT` — SSH private key content
- [ ] `SSH_KNOWN_HOSTS_DEVELOPMENT` — Output of `ssh-keyscan -H <same-as-SSH_HOST_DEVELOPMENT>`

**Shared Secrets (both branches):**
- [ ] `GHCR_PULL_TOKEN` — GitHub Container Registry pull token (PAT with `read:packages` scope)

**CI gates (workflow file, not GitHub Secrets):**
- [ ] Gitleaks step in `build-images` (see [Secret scanning with Gitleaks](#secret-scanning-with-gitleaks))
- [ ] `.gitleaks.toml` committed with narrow allowlists only

**Note:** `APP_PORT` and `DOMAIN` are hardcoded in the workflow (`DOMAIN` must match nginx `server_name` per branch). `APP_DIR` uses the same `SSH_USER_*` branch expression as `SSH_USER` (see [Application directory (`APP_DIR`)](#application-directory-app_dir)) — no GitHub Variables needed for hostnames or Linux usernames.

### Phase 2: Main Server (10 min)

**Server:** `<main-ip>` (use your main host; **Example (SignPortal)** used `178.105.131.69`)

**Base Directory:** `~/<app-dir>/` — **Example (SignSanctum):** `~/signsanctum-app/` · **Example (SignPortal):** `~/signportal-app/`

**Tasks:**
- [ ] Directory structure exists: `certs/`, `logs/`, `data/`, `nginx/`, `secrets/`
- [ ] logind linger: `loginctl enable-linger <deploy-user>` → `Linger=yes`
- [ ] TLS: `certs/fullchain.pem`, `certs/privkey.pem` for the main hostname
- [ ] `secrets/secrets.env` with main runtime secrets
- [ ] Permissions: `chmod 750 secrets/`, `chmod 644 secrets/secrets.env`

### Phase 3: Development Server (15 min)

**Base directory:** `~/<app-dir>/` on the **development** SSH host (**Example (SignSanctum):** `~/signsanctum-app/` · **Example (SignPortal):** `~/signportal-app/` — same directory name on each host is fine).

**Tasks:**
- [ ] Complete [Host runtime: secrets and TLS certificates](#host-runtime-secrets-and-tls-certificates) for the development hostname
- [ ] logind linger enabled for deploy user (`Linger=yes`)
- [ ] `secrets/secrets.env` with **development** credentials (not main values)
- [ ] TLS PEMs for the development hostname (**SignSanctum:** `signsanctum.dihola.io` · **Example (SignPortal):** `signportal.dihola.io`)

### Phase 4: Git Configuration (5 min)

**Local Repository:**
- [ ] Create development branch: `git checkout -b development`
- [ ] Push to origin: `git push -u origin development`
- [ ] Verify workflow triggers on push to `main` (main)
- [ ] Verify workflow triggers on push to `development` (development)

### Phase 5: Verification (5 min)

**GitHub Actions:**
- [ ] All `SSH_*_MAIN` secrets created and verified
- [ ] All `SSH_*_DEVELOPMENT` secrets created and verified
- [ ] `GHCR_PULL_TOKEN` verified
- [ ] Workflow runs without auth errors

**Servers (one checklist per SSH host):**
- [ ] `~/signsanctum-app/secrets/secrets.env` populated (dev host: dev secrets; main host: main secrets)
- [ ] `~/signsanctum-app/certs/` valid for that host's hostname
- [ ] Directory permissions: `secrets/` 750, `secrets.env` 644, PEMs normalized by deploy or `install-certs-to-apps.sh`

**Deployment:**
- [ ] Push to `main` → main server deployment succeeds
- [ ] Push to `development` → development server deployment succeeds
- [ ] Services respond to health checks on correct servers
- [ ] No secrets appear in GitHub Actions logs

---

## Quick Reference

### Update Main secrets

```bash
# Generic
sudo nano ~/<app-dir>/secrets/secrets.env

# Example (SignSanctum)
sudo nano ~/signsanctum-app/secrets/secrets.env
```

### Update Development Secrets

```bash
# Generic — on the development SSH host
nano ~/<app-dir>/secrets/secrets.env

# Example (SignSanctum)
nano ~/signsanctum-app/secrets/secrets.env
```

### Trigger Deployments

```bash
git push origin main          # Deploy to main
git push origin development   # Deploy to development
```

### Check Deployment Status

Go to GitHub repo → **Actions** tab → view workflow run

### View Container Logs

**Main:**
```bash
# Generic
ssh <user>@<main-ip> "podman logs <service>-container"

# Example (SignSanctum)
ssh <user>@<host> "podman logs signsanctum-container"
```

**Development:**
```bash
# Generic
ssh <user>@<dev-ip> "podman logs <service>-container"

# Example (SignSanctum)
ssh <user>@<dev-ip> "podman logs signsanctum-container"
```

### Restart Containers

**Main:**
```bash
# Generic
ssh <user>@<main-ip> "podman pod restart <service>-pod"

# Example (SignSanctum)
ssh <user>@<host> "podman pod restart signsanctum-pod"
```

**Development:**
```bash
# Generic
ssh <user>@<dev-ip> "podman pod restart <service>-pod"

# Example (SignSanctum)
ssh <user>@<dev-ip> "podman pod restart signsanctum-pod"
```

## Environment-Specific Nginx Configuration

### Overview

Nginx configuration differs between development and main environments, particularly for CORS origins and server names. This is managed through environment-specific config files and Docker build arguments.

### Architecture

```
nginx/
├── nginx.main.conf          # Main branch nginx config
└── nginx.development.conf   # Development branch nginx config

nginx.Dockerfile
├── ARG NODE_ENV=main
└── COPY nginx/nginx.${NODE_ENV}.conf /etc/nginx/nginx.conf
```

### Configuration Files

#### Generic Pattern

```
nginx/
├── nginx.main.conf          # Main branch: CORS origins, server_name for main domain
└── nginx.development.conf   # Development branch: CORS origins, server_name for dev domain
```

#### Example (SignPortal)

Illustrates the same `nginx/nginx.${NODE_ENV}.conf` pattern; **Example (SignSanctum)** uses `listen 1443`, `signsanctum.*` hostnames, and different CORS origins — see `nginx/nginx.main.conf` and `nginx/nginx.development.conf` in that service repository.

**`nginx/nginx.main.conf`** (main branch):
```nginx
# CORS origin mapping (main)
map $http_origin $cors_origin {
    default "";
    "https://root.discernible.io:6443" "$http_origin";
    "https://purchase.identyclaw.com:4443" "$http_origin";
    "https://signportal.discernible.io:8443" "$http_origin";
}

server {
    listen 8443 ssl;
    http2 on;
    server_name signportal.discernible.io;
    ...
}
```

**`nginx/nginx.development.conf`** (development branch):
```nginx
# CORS origin mapping (development)
map $http_origin $cors_origin {
    default "";
    "https://root-dev.discernible.io:6443" "$http_origin";
    "https://purchase-dev.identyclaw.com:4443" "$http_origin";
    "https://signportal.dihola.io:8443" "$http_origin";
}

server {
    listen 8443 ssl;
    http2 on;
    server_name signportal.dihola.io;
    ...
}
```

### Build Process

The `nginx.Dockerfile` uses a build argument to select the correct config:

```dockerfile
ARG NODE_ENV=main

COPY nginx/nginx.${NODE_ENV}.conf /etc/nginx/nginx.conf
```

The GitHub Actions workflow passes the `NODE_ENV` build argument based on the branch:

```yaml
- name: Build and push Nginx image
  uses: docker/build-push-action@v6
  with:
    context: .
    file: ./nginx.Dockerfile
    build-args: |
      NODE_ENV=${{ github.ref == 'refs/heads/main' && 'main' || 'development' }}
    tags: |
      ${{ env.REGISTRY }}/${{ env.NGINX_IMAGE_NAME }}:${{ github.sha }}
      ${{ env.REGISTRY }}/${{ env.NGINX_IMAGE_NAME }}:latest
```

**How it works:**
- Pushing to `main` → `NODE_ENV=main` → copies `nginx.main.conf` into image
- Pushing to `development` → `NODE_ENV=development` → copies `nginx.development.conf` into image

### What to Customize for Your Service

When adapting this pattern to another service:

1. **Create two nginx config files:**
   - `nginx/nginx.main.conf` — main origins and server names
   - `nginx/nginx.development.conf` — development origins and server names

2. **Update CORS origins** in each file:
   - Main: use main domain names and origins
   - Development: use development domain names and origins (e.g., add `-dev` suffix)

3. **Update server_name** in each file:
   - Main: `server_name <your-service>.example.com;`
   - Development: `server_name <your-service>-dev.example.com;`

4. **Ensure the Dockerfile has the build argument:**
   ```dockerfile
   ARG NODE_ENV=main
   COPY nginx/nginx.${NODE_ENV}.conf /etc/nginx/nginx.conf
   ```

5. **Ensure the workflow passes the build argument** (same pattern as above).

### Verification

After deployment, verify the correct config was used:

```bash
# SSH into the host and check the running nginx config
ssh <user>@<host> "podman exec <service>-nginx cat /etc/nginx/nginx.conf | grep server_name"

# Example (SignSanctum)
ssh <user>@<host> "podman exec signsanctum-nginx cat /etc/nginx/nginx.conf | grep server_name"
# main: server_name signsanctum.discernible.io;
# development: server_name signsanctum.dihola.io;

# Example (SignPortal)
ssh <user>@<host> "podman exec signportal-nginx cat /etc/nginx/nginx.conf | grep server_name"
```

### Benefits

1. **Isolation:** Development and main CORS origins are completely separate
2. **Safety:** Merging `development` → `main` never overwrites main nginx config
3. **Clarity:** Each environment's nginx config is explicit and version-controlled
4. **Auditability:** All nginx changes are tracked in git with environment context
