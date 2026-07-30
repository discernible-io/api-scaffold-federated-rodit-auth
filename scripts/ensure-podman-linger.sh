#!/usr/bin/env bash
# Enable systemd logind linger for the deploy user so rootless Podman containers
# survive after the last SSH session ends. Idempotent — safe on every deploy.
#
# Usage (CI): ssh user@host "DEPLOY_USER=user bash -s" < scripts/ensure-podman-linger.sh
# Set SKIP_LINGER=1 to skip (rootful Podman or non-systemd hosts).

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-$(id -un)}"
SKIP_LINGER="${SKIP_LINGER:-0}"

if [[ "$SKIP_LINGER" == "1" ]]; then
  echo "SKIP_LINGER=1: skipping linger setup"
  exit 0
fi

if ! command -v loginctl >/dev/null 2>&1; then
  echo "loginctl not found; skipping linger setup (non-systemd host?)"
  exit 0
fi

linger_status() {
  loginctl show-user "$DEPLOY_USER" -p Linger 2>/dev/null | cut -d= -f2
}

current="$(linger_status || true)"
if [[ "$current" == "yes" ]]; then
  echo "Linger already enabled for ${DEPLOY_USER}"
  exit 0
fi

echo "Enabling linger for ${DEPLOY_USER}..."
if loginctl enable-linger "$DEPLOY_USER" 2>/dev/null; then
  :
elif sudo -n loginctl enable-linger "$DEPLOY_USER" 2>/dev/null; then
  :
else
  echo "Could not enable linger for ${DEPLOY_USER}. Run: loginctl enable-linger ${DEPLOY_USER}" >&2
  exit 1
fi

if [[ "$(linger_status)" != "yes" ]]; then
  echo "Linger is not yes after enable attempt for ${DEPLOY_USER}" >&2
  exit 1
fi

echo "Linger=yes for ${DEPLOY_USER}"
