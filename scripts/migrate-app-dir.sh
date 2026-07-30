#!/usr/bin/env bash
# Point ~/syntheticlc-app at existing deploy data (idclawserver uses ~/idclawserver-app).
#
# One-time host fix when CI created an empty ~/syntheticlc-app while data lived under
# ~/servertest-app. Safe to re-run.
#
# Usage:
#   ./scripts/migrate-app-dir.sh
#   APP_DIR=~/syntheticlc-app LEGACY_DIR=~/servertest-app ./scripts/migrate-app-dir.sh

set -euo pipefail

APP_DIR="${APP_DIR:-~/syntheticlc-app}"
LEGACY_DIR="${LEGACY_DIR:-~/servertest-app}"
APP_DIR="${APP_DIR/#\~/$HOME}"
LEGACY_DIR="${LEGACY_DIR/#\~/$HOME}"

if [[ "$APP_DIR" == "$LEGACY_DIR" ]]; then
  echo "APP_DIR and LEGACY_DIR are the same; nothing to do." >&2
  exit 0
fi

if [[ ! -f "${LEGACY_DIR}/secrets/secrets.env" ]]; then
  echo "Legacy secrets not found at ${LEGACY_DIR}/secrets/secrets.env" >&2
  exit 1
fi

if [[ -L "$APP_DIR" ]]; then
  current="$(readlink -f "$APP_DIR")"
  legacy="$(readlink -f "$LEGACY_DIR")"
  if [[ "$current" == "$legacy" ]]; then
    echo "Already linked: $APP_DIR -> $LEGACY_DIR" >&2
    exit 0
  fi
  rm -f "$APP_DIR"
fi

if [[ -f "${APP_DIR}/secrets/secrets.env" ]]; then
  if cmp -s "${APP_DIR}/secrets/secrets.env" "${LEGACY_DIR}/secrets/secrets.env"; then
    echo "APP_DIR already has secrets.env (same as legacy)." >&2
    exit 0
  fi
  echo "APP_DIR secrets differ from legacy; keeping APP_DIR secrets (not overwriting)." >&2
  exit 0
fi

if [[ -d "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]]; then
  echo "Removing empty/partial APP_DIR at $APP_DIR" >&2
  rm -rf "$APP_DIR"
fi

ln -s "$LEGACY_DIR" "$APP_DIR"
echo "Linked $APP_DIR -> $LEGACY_DIR" >&2
