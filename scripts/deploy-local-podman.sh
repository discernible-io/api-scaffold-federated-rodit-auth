#!/usr/bin/env bash
# Local Podman deploy (build on this host, no registry push/pull).
#
# Usage (repo root):
#   ./scripts/deploy-local-podman.sh
#   ./scripts/deploy-local-podman.sh --skip-build

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help)
      head -n 8 "$0"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

[[ -f "${REPO_ROOT}/.deploy.local.env" ]] && set -a && source "${REPO_ROOT}/.deploy.local.env" && set +a

APP_DIR="${APP_DIR:-~/api-idc-app}"
APP_DIR="${APP_DIR/#\~/$HOME}"
APP_PORT="${APP_PORT:-8443}"
POD_NAME="${POD_NAME:-api-idc-pod}"
APP_CONTAINER_NAME="${APP_CONTAINER_NAME:-api-idc-container}"
NGINX_CONTAINER_NAME="${NGINX_CONTAINER_NAME:-api-idc-nginx}"
IMAGE_TAG="${IMAGE_TAG:-local}"
API_IMAGE="${API_IMAGE:-localhost/api-idc-api:${IMAGE_TAG}}"
NGINX_IMAGE="${NGINX_IMAGE:-localhost/api-idc-nginx:${IMAGE_TAG}}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  podman build -f api.Dockerfile -t "$API_IMAGE" .
  podman build -f nginx.Dockerfile -t "$NGINX_IMAGE" .
fi

DEPLOY_USER="${USER}"
bash "${REPO_ROOT}/scripts/ensure-podman-linger.sh"

mkdir -p "${APP_DIR}/"{certs,logs,data,nginx,secrets} "${APP_DIR}/logs/nginx"
podman pod rm -f "$POD_NAME" || true
podman pod create --name "$POD_NAME" -p "${APP_PORT}:${APP_PORT}"

podman run -d \
  --pod "$POD_NAME" \
  --name "$APP_CONTAINER_NAME" \
  --user 1000:1000 \
  --restart=unless-stopped \
  --env-file "${APP_DIR}/secrets/secrets.env" \
  -v "${APP_DIR}/logs:/app/logs:Z" \
  -v "${APP_DIR}/data:/app/data:Z" \
  -v "${APP_DIR}/certs:/app/certs:ro,Z" \
  "$API_IMAGE"

podman run -d \
  --pod "$POD_NAME" \
  --name "$NGINX_CONTAINER_NAME" \
  --restart=unless-stopped \
  -v "${APP_DIR}/certs:/app/certs:ro,Z" \
  -v "${APP_DIR}/logs/nginx:/var/log/nginx:Z,U" \
  "$NGINX_IMAGE"

sleep 5
podman exec "$APP_CONTAINER_NAME" node /app/scripts/run-deployment-api-tests.js || true
echo "Local deploy complete. Pod: $POD_NAME API port $APP_PORT"
