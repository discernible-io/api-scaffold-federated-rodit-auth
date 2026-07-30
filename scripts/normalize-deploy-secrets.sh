#!/usr/bin/env bash
# Normalize deploy SSH secret values (idclawserver-idc pattern).
#
# SSH_HOST_* must be hostname or IP only — never a known_hosts line or hashed entry.
# SSH_KNOWN_HOSTS_* must be the output of: ssh-keyscan -H <same-as-SSH_HOST_*>
#
# Usage:
#   ./scripts/normalize-deploy-secrets.sh --target development
#   ./scripts/normalize-deploy-secrets.sh --target main --host 178.105.128.230
#   ./scripts/normalize-deploy-secrets.sh --target main --apply-gh
#
# Optional: source .deploy.local.env for SSH_HOST / SSH_HOST_* overrides.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TARGET=""
HOST_OVERRIDE=""
APPLY_GH=0
DRY_RUN=0
GITHUB_REPO="${GITHUB_REPOSITORY:-discernible-io/api-idc}"

usage() {
  sed -n '1,16p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --host) HOST_OVERRIDE="${2:-}"; shift 2 ;;
    --apply-gh) APPLY_GH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

[[ -f "${REPO_ROOT}/.deploy.local.env" ]] && set -a && source "${REPO_ROOT}/.deploy.local.env" && set +a

case "$TARGET" in
  development)
    DOMAIN="${DOMAIN:-slc.dihola.io}"
    SSH_HOST_RAW="${HOST_OVERRIDE:-${SSH_HOST:-${SSH_HOST_DEVELOPMENT:-}}}"
    SECRET_HOST="SSH_HOST_DEVELOPMENT"
    SECRET_KNOWN="SSH_KNOWN_HOSTS_DEVELOPMENT"
    ;;
  main)
    DOMAIN="${DOMAIN:-slc.discernible.io}"
    SSH_HOST_RAW="${HOST_OVERRIDE:-${SSH_HOST:-${SSH_HOST_MAIN:-}}}"
    SECRET_HOST="SSH_HOST_MAIN"
    SECRET_KNOWN="SSH_KNOWN_HOSTS_MAIN"
    ;;
  *)
    echo "--target development|main is required" >&2
    exit 1
    ;;
esac

is_malformed_host() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" == \|* ]] && return 0
  [[ "$value" == *" ecdsa-"* ]] && return 0
  [[ "$value" == *" ssh-rsa "* ]] && return 0
  [[ "$value" == *" ssh-ed25519 "* ]] && return 0
  return 1
}

normalize_host() {
  local raw="$1"
  local candidate="${raw%% *}"
  candidate="${candidate//$'\r'/}"
  candidate="${candidate//$'\n'/}"
  if is_malformed_host "$candidate"; then
    candidate=""
  fi
  if [[ -z "$candidate" && -n "$DOMAIN" ]]; then
  local resolved
    resolved="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '/STREAM/ { print $1; exit }')"
    if [[ -n "$resolved" ]]; then
      candidate="$resolved"
    fi
  fi
  printf '%s' "$candidate"
}

HOST="$(normalize_host "$SSH_HOST_RAW")"

if [[ -z "$HOST" ]]; then
  echo "Could not resolve SSH host for TARGET=$TARGET." >&2
  echo "Pass --host <ip-or-hostname> or set ${SECRET_HOST} to hostname/IP only (not known_hosts)." >&2
  exit 1
fi

if is_malformed_host "$SSH_HOST_RAW"; then
  echo "Malformed ${SECRET_HOST}: looks like known_hosts material, not a connect hostname." >&2
  echo "  Will use: $HOST" >&2
else
  echo "SSH host for $TARGET: $HOST" >&2
fi

KNOWN_HOSTS="$(ssh-keyscan -H "$HOST" 2>/dev/null | sed '/^#/d' | sed '/^$/d')"
if [[ -z "$KNOWN_HOSTS" ]]; then
  echo "ssh-keyscan returned no keys for $HOST" >&2
  exit 1
fi

echo ""
echo "=== Normalized values (TARGET=$TARGET) ==="
echo "${SECRET_HOST}=${HOST}"
echo ""
echo "${SECRET_KNOWN}=<<EOF"
printf '%s\n' "$KNOWN_HOSTS"
echo "EOF"

if [[ "$DRY_RUN" -eq 1 ]]; then
  exit 0
fi

if [[ "$APPLY_GH" -eq 1 ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI is required for --apply-gh" >&2
    exit 1
  fi
  printf '%s' "$HOST" | gh secret set "$SECRET_HOST" --repo "$GITHUB_REPO"
  printf '%s\n' "$KNOWN_HOSTS" | gh secret set "$SECRET_KNOWN" --repo "$GITHUB_REPO"
  echo "Updated GitHub secrets ${SECRET_HOST} and ${SECRET_KNOWN} on ${GITHUB_REPO}" >&2
fi
