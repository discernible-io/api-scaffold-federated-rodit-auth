# Container deployment

> **Before editing:** Review [`documentation-standard.md`](documentation-standard.md).

**Created:** 2026-05-14

How to run this peer with rootless Podman on a single host. Images are built locally. Runtime secrets and TLS stay on the host.

## Layout on the host

```
~/api-idc-app/
├── certs/              # fullchain.pem, privkey.pem (operator-provisioned)
├── logs/
├── data/               # SQLite
├── nginx/              # reference only; live config is in the image
└── secrets/
    └── secrets.env     # operator-provisioned; --env-file at runtime
```

Create it once:

```bash
mkdir -p ~/api-idc-app/{certs,logs,data,nginx,secrets}
chmod 750 ~/api-idc-app/secrets
chmod 644 ~/api-idc-app/secrets/secrets.env
loginctl enable-linger "$(whoami)"
```

Map secret keys through [`config/custom-environment-variables.json`](../config/custom-environment-variables.json). Keep each `KEY=value` on one line (especially `*_JSON_B64`). See [`configuration-standard.md`](configuration-standard.md).

## Local deploy

From the repo root:

```bash
./scripts/deploy-local-podman.sh
```

That script:

1. Enables logind linger ([`scripts/ensure-podman-linger.sh`](../scripts/ensure-podman-linger.sh)).
2. Builds `api.Dockerfile` and `nginx.Dockerfile` as local image tags.
3. Recreates `api-idc-pod` with the API and nginx containers.
4. Injects `~/api-idc-app/secrets/secrets.env` via `--env-file`.
5. Runs [`scripts/run-deployment-api-tests.js`](../scripts/run-deployment-api-tests.js) inside the API container (findings only; does not fail the script).

Optional: `--skip-build` to reuse already-built tags. Override paths with `APP_DIR`, `APP_PORT`, `API_IMAGE`, `NGINX_IMAGE`.

nginx listens on **8443** (rootless Podman cannot bind ports below 1024). The API listens on **8080** inside the pod only.

After start:

```bash
podman logs api-idc-container 2>&1 | rg 'Configuration validation passed|Resolved configuration at startup'
curl -k https://127.0.0.1:8443/health
```

## Images

[`api.Dockerfile`](../api.Dockerfile) is a two-stage Node 20 Alpine build: `npm ci` in **builder**, production stage copies the tree, installs `tini` from `apk`, and **removes npm/npx**. `CMD` is `node src/app.js`.

[`nginx.Dockerfile`](../nginx.Dockerfile) copies [`nginx/nginx.conf`](../nginx/nginx.conf). Edit `server_name` and CORS origins there for your peer hostname.

## TLS

Install `fullchain.pem` and `privkey.pem` in `~/api-idc-app/certs/`. Before nginx starts, apply rootless ownership (`podman unshare chown 101:101`), **600** on the private key, **644** on the chain, **711** on `certs/`.

## Secret scanning (optional, local)

```bash
gitleaks detect --source . --verbose --redact
```

Allowlists live in [`.gitleaks.toml`](../.gitleaks.toml). Runtime secrets belong in host `secrets.env`, not in git.

## Supply-chain age gate

`npm install` runs [`scripts/enforce-minimum-package-age.js`](../scripts/enforce-minimum-package-age.js) via the `preinstall` hook. The same script can be run by hand before a container build.
